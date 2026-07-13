/**
 * Thread bootstrap utilities.
 *
 * Channel model:
 *   - Per-agent Personal: one active private conversation per (user × agent),
 *     pod-scoped, with archived conversations retained as history.
 *   - Workspace group: one shared thread per (user × workspace).
 *   - Proactive feed: AI-only broadcast channel, pod-scoped.
 */

import { randomUUID } from "node:crypto";
import {
  db,
  eq,
  and,
  asc,
  desc,
  inArray,
  isNull,
  isNotNull,
  drizzleSql,
  computeMessageHash,
} from "@synap/database";
import {
  channels,
  channelMembers,
  ChannelMemberKind,
  ChannelMemberRole,
  messages,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  sessions,
  SessionStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  agents,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "personal-channel" });

const notInstanceThread = drizzleSql`(${channels.metadata} ->> 'agentInstanceThread') IS NULL`;

async function getSyncAgentId(slug: string): Promise<string | null> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.slug, slug), eq(agents.active, true)))
    .limit(1);
  return agent?.id ?? null;
}

/**
 * Resolve an agent UUID by slug. Returns null if not found or inactive.
 * Exported for use by callers that need to resolve a default agent ID.
 */
export async function getAgentIdBySlug(slug: string): Promise<string | null> {
  return getSyncAgentId(slug);
}

/**
 * A template PERSONAL channel is the user-to-agent conversation managed by the
 * per-(user, template-agent) active-row constraint. Agent-instance threads use
 * the same channel type but are marked and have their own membership-based key.
 */
export function isTemplatePersonalChannel(
  channel: Pick<Channel, "channelType" | "assignedAgentId" | "metadata">
): boolean {
  const metadata = channel.metadata;
  const isAgentInstance =
    typeof metadata === "object" &&
    metadata !== null &&
    "agentInstanceThread" in metadata &&
    (metadata as { agentInstanceThread?: unknown }).agentInstanceThread ===
      true;

  return (
    channel.channelType === ChannelType.PERSONAL &&
    channel.assignedAgentId !== null &&
    !isAgentInstance
  );
}

export interface PersonalConversationTransition {
  channel: Channel;
  archivedChannelIds: string[];
}

export interface PersonalConversationHistoryItem {
  channel: Channel;
  /** Channel title, falling back to the latest user turn or a neutral label. */
  title: string;
  /** Bounded latest user-message excerpt for history scanning. */
  preview: string | null;
  lastActivity: Date;
  messageCount: number;
}

/**
 * Start a fresh Personal conversation for an agent. Existing active template
 * conversations are archived first; archived conversations remain intact for
 * History. This intentionally does not seed the onboarding welcome again.
 */
export async function startNewPersonalConversation(
  userId: string,
  agentId: string
): Promise<PersonalConversationTransition> {
  return db.transaction(async (tx) => {
    const activeChannels = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.assignedAgentId, agentId),
          eq(channels.channelType, ChannelType.PERSONAL),
          eq(channels.status, ChannelStatus.ACTIVE),
          notInstanceThread
        )
      )
      .for("update");
    const archivedChannelIds = activeChannels.map((channel) => channel.id);
    const now = new Date();

    if (archivedChannelIds.length > 0) {
      await tx
        .update(channels)
        .set({ status: ChannelStatus.ARCHIVED, updatedAt: now })
        .where(inArray(channels.id, archivedChannelIds));
      await tx
        .update(sessions)
        .set({ status: SessionStatus.CLOSED, endedAt: now })
        .where(
          and(
            inArray(sessions.channelId, archivedChannelIds),
            eq(sessions.status, SessionStatus.ACTIVE)
          )
        );
    }

    const [created] = await tx
      .insert(channels)
      .values({
        userId,
        workspaceId: null,
        channelType: ChannelType.PERSONAL,
        scope: ChannelScope.POD,
        status: ChannelStatus.ACTIVE,
        assignedAgentId: agentId,
      })
      .onConflictDoNothing({
        target: [channels.userId, channels.assignedAgentId],
        where: and(
          eq(channels.channelType, ChannelType.PERSONAL),
          isNotNull(channels.assignedAgentId),
          eq(channels.status, ChannelStatus.ACTIVE),
          notInstanceThread
        ),
      })
      .returning();

    if (created) return { channel: created, archivedChannelIds };

    const [survivor] = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.assignedAgentId, agentId),
          eq(channels.channelType, ChannelType.PERSONAL),
          eq(channels.status, ChannelStatus.ACTIVE),
          notInstanceThread
        )
      )
      .orderBy(asc(channels.createdAt))
      .limit(1);
    if (!survivor) {
      throw new Error(
        `Failed to start PERSONAL conversation for user=${userId} agent=${agentId}`
      );
    }
    return { channel: survivor, archivedChannelIds };
  });
}

/**
 * Archive a template Personal conversation and close its active internal
 * sessions. The row remains readable through History.
 */
export async function closePersonalConversation(
  userId: string,
  channelId: string
): Promise<Channel | null> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.PERSONAL),
          eq(channels.status, ChannelStatus.ACTIVE),
          isNotNull(channels.assignedAgentId),
          notInstanceThread
        )
      )
      .for("update")
      .limit(1);
    if (!channel) return null;

    const now = new Date();
    const [closed] = await tx
      .update(channels)
      .set({ status: ChannelStatus.ARCHIVED, updatedAt: now })
      .where(eq(channels.id, channelId))
      .returning();
    await tx
      .update(sessions)
      .set({ status: SessionStatus.CLOSED, endedAt: now })
      .where(
        and(
          eq(sessions.channelId, channelId),
          eq(sessions.status, SessionStatus.ACTIVE)
        )
      );

    return closed ?? null;
  });
}

/**
 * Reopen an archived template Personal conversation. It becomes the sole active
 * conversation for its original agent; no agent configuration or membership
 * data is rewritten.
 */
export async function reopenPersonalConversation(
  userId: string,
  channelId: string
): Promise<PersonalConversationTransition | null> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.PERSONAL),
          eq(channels.status, ChannelStatus.ARCHIVED),
          isNotNull(channels.assignedAgentId),
          notInstanceThread
        )
      )
      .for("update")
      .limit(1);
    if (!target?.assignedAgentId) return null;

    const activeChannels = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.assignedAgentId, target.assignedAgentId),
          eq(channels.channelType, ChannelType.PERSONAL),
          eq(channels.status, ChannelStatus.ACTIVE),
          notInstanceThread
        )
      )
      .for("update");
    const archivedChannelIds = activeChannels.map((channel) => channel.id);
    const now = new Date();

    if (archivedChannelIds.length > 0) {
      await tx
        .update(channels)
        .set({ status: ChannelStatus.ARCHIVED, updatedAt: now })
        .where(inArray(channels.id, archivedChannelIds));
      await tx
        .update(sessions)
        .set({ status: SessionStatus.CLOSED, endedAt: now })
        .where(
          and(
            inArray(sessions.channelId, archivedChannelIds),
            eq(sessions.status, SessionStatus.ACTIVE)
          )
        );
    }

    const [reopened] = await tx
      .update(channels)
      .set({ status: ChannelStatus.ACTIVE, updatedAt: now })
      .where(
        and(
          eq(channels.id, target.id),
          eq(channels.status, ChannelStatus.ARCHIVED)
        )
      )
      .returning();
    if (!reopened) return null;

    return { channel: reopened, archivedChannelIds };
  });
}

/** List archived template Personal conversations for a specific agent. */
export async function listPersonalConversationHistory(
  userId: string,
  agentId: string,
  limit: number,
  offset: number
): Promise<PersonalConversationHistoryItem[]> {
  const lastActivity = drizzleSql<Date>`COALESCE(MAX(${messages.timestamp}), ${channels.updatedAt})`;
  const latestUserPreview = drizzleSql<string | null>`(
    SELECT LEFT(history_message.content, 160)
    FROM messages AS history_message
    WHERE history_message.channel_id = ${channels.id}
      AND history_message.role = ${MessageRole.USER}
      AND history_message.deleted_at IS NULL
      AND history_message.ephemeral = false
    ORDER BY history_message.timestamp DESC
    LIMIT 1
  )`;
  const rows = await db
    .select({
      channel: channels,
      preview: latestUserPreview,
      lastActivity,
      messageCount: drizzleSql<number>`COUNT(${messages.id})::int`,
    })
    .from(channels)
    .leftJoin(
      messages,
      and(
        eq(messages.channelId, channels.id),
        isNull(messages.deletedAt),
        eq(messages.ephemeral, false)
      )
    )
    .where(
      and(
        eq(channels.userId, userId),
        eq(channels.assignedAgentId, agentId),
        eq(channels.channelType, ChannelType.PERSONAL),
        eq(channels.status, ChannelStatus.ARCHIVED),
        notInstanceThread
      )
    )
    .groupBy(channels.id)
    .orderBy(desc(lastActivity), desc(channels.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    ...row,
    title: row.channel.title ?? row.preview ?? "New conversation",
  }));
}

/**
 * Static onboarding greeting seeded on first-ever channel creation with an agent.
 * Static copy avoids IS latency on first login.
 */
const AGENT_THREAD_WELCOME_MESSAGE = `Hey — I'm your co-founder here. Welcome to your data pod. This is just us — private, yours, forever.

Before I can help well, I want to understand a bit about what's on your plate. No forms, no presets — just a conversation. We'll start with what you're working on right now, then I'll ask about the people, projects, and moments you want to remember. As you talk, I'll quietly start structuring things. You can always import anything you already have — notes, LinkedIn, files, wherever. Ready?`;

async function seedWelcomeMessage(
  channelId: string,
  userId: string
): Promise<void> {
  try {
    const messageId = randomUUID();
    const hash = computeMessageHash(messageId, AGENT_THREAD_WELCOME_MESSAGE);
    const seedMetadata = { agentType: "onboarding" };
    await db.insert(messages).values({
      id: messageId,
      channelId,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      messageCategory: MessageCategory.CHAT,
      content: AGENT_THREAD_WELCOME_MESSAGE,
      userId,
      previousHash: "",
      hash,
      metadata: seedMetadata as (typeof messages.$inferInsert)["metadata"],
    });
  } catch (err: unknown) {
    logger.error(
      { err, channelId, userId },
      "Failed to seed welcome message — continuing"
    );
  }
}

/**
 * Resolve the active private conversation between a user and a specific agent.
 * Pod-scoped: one active channel per (userId, agentId), shared across all workspaces.
 * Seeds a welcome message on first creation (orchestrator agent only).
 */
export async function ensureAgentThread(
  userId: string,
  agentId: string
): Promise<Channel> {
  // A template DM (this function) and an agent-INSTANCE thread
  // (ensureAgentInstanceThread) both carry assignedAgentId = the same template,
  // but the instance thread is dedup'd on channel_members, not on the template.
  // The `agentInstanceThread` metadata marker distinguishes them: template DMs
  // never set it, instance threads always do. Resolve/dedup ONLY template DMs
  // here (and channels_user_agent_personal_uniq excludes marked rows) so two
  // instances of the same template never collide with — or resolve to — the
  // template DM.
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.assignedAgentId, agentId),
      eq(channels.status, ChannelStatus.ACTIVE),
      eq(channels.channelType, ChannelType.PERSONAL),
      notInstanceThread
    ),
    // Deterministic oldest-wins: if duplicate threads exist, always resolve the
    // canonical original so proactive/agent posts don't scatter run-to-run.
    orderBy: [asc(channels.createdAt)],
  });

  if (existing) return existing;

  // Race-safe upsert against channels_user_agent_personal_uniq (migration 0182):
  // the loser of a concurrent create no-ops, then we re-SELECT the survivor.
  // Mirrors the ensureExternalChannel template so every resolver dedups identically.
  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: agentId,
    })
    .onConflictDoNothing({
      target: [channels.userId, channels.assignedAgentId],
      where: and(
        eq(channels.channelType, ChannelType.PERSONAL),
        isNotNull(channels.assignedAgentId),
        eq(channels.status, ChannelStatus.ACTIVE),
        notInstanceThread
      ),
    })
    .returning();

  if (!channel) {
    const survivor = await db.query.channels.findFirst({
      where: and(
        eq(channels.userId, userId),
        eq(channels.assignedAgentId, agentId),
        eq(channels.status, ChannelStatus.ACTIVE),
        eq(channels.channelType, ChannelType.PERSONAL),
        notInstanceThread
      ),
      orderBy: [asc(channels.createdAt)],
    });
    if (!survivor) {
      throw new Error(
        `Failed to resolve-or-create PERSONAL channel for user=${userId} agent=${agentId} after conflict`
      );
    }
    return survivor;
  }

  // Seed welcome message only for the orchestrator agent
  const orchestratorId = await getSyncAgentId("orchestrator");
  if (orchestratorId && agentId === orchestratorId) {
    await seedWelcomeMessage(channel.id, userId);
  }

  return channel;
}

/**
 * Get or create a private thread between a user and a specific agent INSTANCE.
 *
 * Per-instance linkage: `channels.assignedAgentId` is an FK to the `agents`
 * (templates) table, so it cannot hold an instance id. The instance (a `users`
 * row, userType=agent) is therefore attached via `channel_members` (kind=ai_agent),
 * which is also the dedup key — one thread per (user × instance). `assignedAgentId`
 * still carries the resolved TEMPLATE so the IS knows which agent class to run.
 *
 * @param userId           the human owner of the thread
 * @param agentUserId      the agent instance (users.id, userType=agent)
 * @param templateAgentId  the resolved template (agents.id) for IS routing, or null
 */
export async function ensureAgentInstanceThread(
  userId: string,
  agentUserId: string,
  templateAgentId: string | null
): Promise<Channel> {
  // Dedup on the INSTANCE membership, not on assignedAgentId (which is per-type).
  const [existing] = await db
    .select({ channel: channels })
    .from(channels)
    .innerJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.memberId, agentUserId),
        eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
      )
    )
    .where(
      and(
        eq(channels.userId, userId),
        eq(channels.channelType, ChannelType.PERSONAL),
        eq(channels.status, ChannelStatus.ACTIVE)
      )
    )
    // Deterministic oldest-wins on duplicate instance threads.
    .orderBy(asc(channels.createdAt))
    .limit(1);

  if (existing) return existing.channel;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: templateAgentId, // template → IS agent class
      // Marker: this is an INSTANCE thread, dedup'd on channel_members — NOT a
      // template DM. It shares assignedAgentId with the template DM + sibling
      // instances, so it MUST be excluded from channels_user_agent_personal_uniq
      // (which is per (user, template)) or two instances of one template collide.
      metadata: { agentInstanceThread: true },
    })
    .returning();

  // The per-instance link lives in channel_members (assignedAgentId is template-only).
  await db.insert(channelMembers).values([
    {
      channelId: channel.id,
      memberId: userId,
      memberKind: ChannelMemberKind.HUMAN,
      role: ChannelMemberRole.OWNER,
      addedBy: userId,
    },
    {
      channelId: channel.id,
      memberId: agentUserId,
      memberKind: ChannelMemberKind.AI_AGENT,
      role: ChannelMemberRole.MEMBER,
      addedBy: userId,
    },
  ]);

  // Welcome seed only when the resolved template is the orchestrator (mirrors ensureAgentThread).
  const orchestratorId = await getSyncAgentId("orchestrator");
  if (orchestratorId && templateAgentId === orchestratorId) {
    await seedWelcomeMessage(channel.id, userId);
  }

  return channel;
}

/**
 * Get or create a workspace-wide group thread.
 * One per (userId, workspaceId). No assigned agent — humans and AI can both participate.
 * Agents can be @mentioned; the workspace default IS handles routing.
 */
export async function ensureWorkspaceGroupChannel(
  userId: string,
  workspaceId: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.workspaceId, workspaceId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.contextObjectType, "workspace"),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    // Deterministic oldest-wins on duplicate workspace group threads.
    orderBy: [asc(channels.createdAt)],
  });

  if (existing) return existing;

  // Race-safe upsert against channels_user_workspace_group_uniq (migration 0182).
  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId,
      channelType: ChannelType.THREAD,
      contextObjectType: "workspace",
      contextObjectId: workspaceId,
      scope: ChannelScope.WORKSPACE,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: null,
      title: "General",
    })
    .onConflictDoNothing({
      target: [channels.userId, channels.workspaceId],
      where: and(
        eq(channels.channelType, ChannelType.THREAD),
        eq(channels.contextObjectType, "workspace"),
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
    })
    .returning();

  if (channel) return channel;

  const survivor = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.workspaceId, workspaceId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.contextObjectType, "workspace"),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    orderBy: [asc(channels.createdAt)],
  });
  if (!survivor) {
    throw new Error(
      `Failed to resolve-or-create workspace group channel for user=${userId} ws=${workspaceId} after conflict`
    );
  }
  return survivor;
}

/**
 * Get or create the user's proactive FEED channel (pod-wide, user-scoped).
 * AI-initiated posts only: morning briefings, event prep, automation summaries.
 * Rate-limited via /api/hub/proactive/post (3/hr, 10/day).
 * User reads, taps to open a conversation — does not type directly here.
 */
export async function ensureProactiveFeedChannel(
  userId: string,
  _workspaceId?: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    // Deterministic oldest-wins: if duplicate feed channels exist, always resolve
    // the canonical original so proactive posts don't scatter run-to-run.
    orderBy: [asc(channels.createdAt)],
  });

  if (existing) return existing;

  // Race-safe upsert against channels_user_feed_uniq (migration 0182) — one feed
  // per user. Arbiter where matches the partial index predicate exactly.
  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.FEED,
      scope: ChannelScope.POD,
      feedScope: FeedScope.USER,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: await getSyncAgentId("orchestrator"),
    })
    .onConflictDoNothing({
      target: [channels.userId],
      where: and(
        eq(channels.channelType, ChannelType.FEED),
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
    })
    .returning();

  if (channel) return channel;

  const survivor = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.FEED),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    orderBy: [asc(channels.createdAt)],
  });
  if (!survivor) {
    throw new Error(
      `Failed to resolve-or-create FEED channel for user=${userId} after conflict`
    );
  }
  return survivor;
}
