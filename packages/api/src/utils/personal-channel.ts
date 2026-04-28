/**
 * Thread bootstrap utilities.
 *
 * Channel model:
 *   - Per-agent thread: one private thread per (user × agent), pod-scoped.
 *   - Workspace group: one shared thread per (user × workspace).
 *   - Proactive feed: AI-only broadcast channel, pod-scoped.
 */

import { randomUUID, createHash } from "node:crypto";
import { db, eq, and } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelScope,
  FeedScope,
  ThreadKind,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  agents,
} from "@synap/database/schema";
import type { Channel } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "personal-channel" });

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
    const hash = createHash("sha256")
      .update(`${messageId}${AGENT_THREAD_WELCOME_MESSAGE}`)
      .digest("hex");
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
 * Get or create a private thread between a user and a specific agent.
 * Pod-scoped: one channel per (userId, agentId), shared across all workspaces.
 * Seeds a welcome message on first creation (orchestrator agent only).
 */
export async function ensureAgentThread(
  userId: string,
  agentId: string
): Promise<Channel> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.assignedAgentId, agentId),
      eq(channels.threadKind, ThreadKind.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: agentId,
    })
    .returning();

  // Seed welcome message only for the orchestrator agent
  const orchestratorId = await getSyncAgentId("orchestrator");
  if (orchestratorId && agentId === orchestratorId) {
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
      eq(channels.threadKind, ThreadKind.WORKSPACE),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
  });

  if (existing) return existing;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId,
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.WORKSPACE,
      scope: ChannelScope.WORKSPACE,
      status: ChannelStatus.ACTIVE,
      assignedAgentId: null,
      title: "General",
    })
    .returning();

  return channel;
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
  });

  if (existing) return existing;

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
    .returning();

  return channel;
}
