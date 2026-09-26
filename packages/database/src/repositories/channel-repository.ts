/**
 * Channel Repository
 *
 * Standalone repository for channels.
 * Handles CRUD operations with event emission.
 */

import { eq, and, asc, desc, isNull, sql as drizzleSql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import {
  channels,
  type Channel,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
} from "../schema/channels.js";
import { agents } from "../schema/agents.js";
import { documents } from "../schema/documents.js";
import { entities } from "../schema/entities.js";
import type { ObjectRoomType } from "../utils/channel-visibility.js";
import { EventRepository } from "./event-repository.js";
import { sql } from "../client-pg.js";

/** Postgres unique-violation SQLSTATE — raised by the channel dedup indexes. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

export interface CreateChannelData {
  id?: string;
  userId: string;
  workspaceId?: string;
  title?: string;
  channelType?: ChannelType;
  contextObjectType?: string;
  contextObjectId?: string;
  parentChannelId?: string;
  branchedFromMessageId?: string;
  branchPurpose?: string;
  senderAgentId?: string;
  assignedAgentId?: string;
  agentConfig?: Record<string, unknown>;
  externalSource?: string;
  externalChannelId?: string;
  scope?: ChannelScope;
  feedScope?: FeedScope;
  metadata?: Record<string, unknown>;
}

export interface UpdateChannelData {
  title?: string;
  status?: ChannelStatus;
  contextSummary?: string;
  metadata?: Record<string, unknown>;
  mergedAt?: Date;
}

export class ChannelRepository {
  private eventRepo: EventRepository;

  constructor(private db: PostgresJsDatabase<typeof schema>) {
    this.eventRepo = new EventRepository(sql);
  }

  /**
   * Create a new channel
   */
  async create(data: CreateChannelData): Promise<Channel> {
    const { randomUUID } = await import("crypto");
    const channelId = data.id || randomUUID();

    const [channel] = await this.db
      .insert(channels)
      .values({
        id: channelId,
        userId: data.userId,
        workspaceId: data.workspaceId,
        title: data.title,
        channelType: data.channelType || ChannelType.THREAD,
        scope: data.scope || ChannelScope.WORKSPACE,
        feedScope: data.feedScope,
        contextObjectType: data.contextObjectType,
        contextObjectId: data.contextObjectId,
        parentChannelId: data.parentChannelId,
        branchedFromMessageId: data.branchedFromMessageId,
        branchPurpose: data.branchPurpose,
        senderAgentId: data.senderAgentId || null,
        assignedAgentId: data.assignedAgentId || null,
        agentConfig: data.agentConfig,
        externalSource: data.externalSource,
        externalChannelId: data.externalChannelId,
        metadata: data.metadata,
        status: ChannelStatus.ACTIVE,
      })
      .returning();

    await this.emitCompleted("create", channelId, data.userId);
    return channel;
  }

  /**
   * Update a channel
   */
  async update(
    id: string,
    data: UpdateChannelData,
    userId: string
  ): Promise<Channel> {
    const [channel] = await this.db
      .update(channels)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, id))
      .returning();

    if (!channel) {
      throw new Error(`Channel ${id} not found`);
    }

    await this.emitCompleted("update", id, userId);
    return channel;
  }

  /**
   * Delete a channel (soft delete — sets status to ARCHIVED)
   */
  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .update(channels)
      .set({
        status: ChannelStatus.ARCHIVED,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, id));

    await this.emitCompleted("delete", id, userId);
  }

  /**
   * Get a channel by ID
   */
  async getById(id: string): Promise<Channel | null> {
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);
    return channel || null;
  }

  /**
   * List user's channels
   */
  async listByUser(
    userId: string,
    filters?: {
      workspaceId?: string;
      status?: ChannelStatus;
      channelType?: ChannelType;
    }
  ): Promise<Channel[]> {
    const conditions = [eq(channels.userId, userId)];

    if (filters?.workspaceId) {
      conditions.push(eq(channels.workspaceId, filters.workspaceId));
    }
    if (filters?.status) {
      conditions.push(eq(channels.status, filters.status));
    }
    if (filters?.channelType) {
      conditions.push(eq(channels.channelType, filters.channelType));
    }

    return await this.db
      .select()
      .from(channels)
      .where(and(...conditions))
      .orderBy(desc(channels.updatedAt));
  }

  /**
   * Get branch channels of a parent channel
   */
  async getBranches(parentChannelId: string): Promise<Channel[]> {
    return await this.db
      .select()
      .from(channels)
      .where(eq(channels.parentChannelId, parentChannelId))
      .orderBy(desc(channels.createdAt));
  }

  /**
   * Merge a branch channel into its parent
   */
  async mergeBranch(
    branchId: string,
    contextSummary: string,
    userId: string
  ): Promise<Channel> {
    const [channel] = await this.db
      .update(channels)
      .set({
        status: ChannelStatus.MERGED,
        contextSummary,
        mergedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, branchId))
      .returning();

    if (!channel) {
      throw new Error(`Channel ${branchId} not found`);
    }

    await this.emitCompleted("update", branchId, userId);
    return channel;
  }

  /**
   * Get or create the user's personal thread (pod-wide).
   * Pure user↔AI conversation — nothing automated goes here.
   * Pod-wide: one per user across all workspaces (workspaceId NOT in WHERE clause).
   */
  async ensurePersonalChannel(
    userId: string,
    agentId: string,
    _workspaceId?: string
  ): Promise<Channel> {
    // Resolve ONLY the template DM, never an agent-INSTANCE thread — those share
    // assignedAgentId with the template but are marked + dedup'd on channel_members
    // (see ensureAgentInstanceThread + channels_user_agent_personal_uniq).
    const notInstanceThread = drizzleSql`(${channels.metadata} ->> 'agentInstanceThread') IS NULL`;
    const [existing] = await this.db
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
      // Deterministic oldest-wins on duplicate personal threads.
      .orderBy(asc(channels.createdAt))
      .limit(1);

    if (existing) return existing;

    // Race-safe against channels_user_agent_personal_uniq (migration 0182): if a
    // concurrent create wins, the unique index raises 23505 — re-select the survivor
    // instead of surfacing a duplicate-key error or (pre-0182) silently duping.
    try {
      return await this.create({
        userId,
        workspaceId: undefined, // pod-wide
        channelType: ChannelType.PERSONAL,
        scope: ChannelScope.POD,
        assignedAgentId: agentId,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [survivor] = await this.db
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
      if (!survivor) throw err;
      return survivor;
    }
  }

  /**
   * Get or create the user's proactive FEED channel (pod-wide, user-scoped).
   * AI-initiated posts: morning briefings, event prep, automation summaries.
   * Pod-wide: one per user across all workspaces.
   */
  async ensureProactiveFeedChannel(
    userId: string,
    _workspaceId?: string
  ): Promise<Channel> {
    const [existing] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.FEED),
          eq(channels.status, ChannelStatus.ACTIVE),
          // The proactive feed is the CONTEXT-LESS feed. Automation run-recap
          // channels are also feed-typed (context_object_type='automation') and
          // must not be mistaken for it — this mirrors the narrowed
          // channels_user_feed_uniq arbiter (migration 0210).
          isNull(channels.contextObjectType)
        )
      )
      // Deterministic oldest-wins on duplicate feed channels.
      .orderBy(asc(channels.createdAt))
      .limit(1);

    if (existing) return existing;

    // Race-safe against channels_user_feed_uniq (migrations 0182 + 0210).
    try {
      return await this.create({
        userId,
        workspaceId: undefined, // pod-wide
        channelType: ChannelType.FEED,
        scope: ChannelScope.POD,
        feedScope: FeedScope.USER,
        senderAgentId: undefined,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [survivor] = await this.db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.userId, userId),
            eq(channels.channelType, ChannelType.FEED),
            eq(channels.status, ChannelStatus.ACTIVE),
            // Same context-less arbiter as the pre-insert read above.
            isNull(channels.contextObjectType)
          )
        )
        .orderBy(asc(channels.createdAt))
        .limit(1);
      if (!survivor) throw err;
      return survivor;
    }
  }

  /**
   * Get or create THE channel for an automation — ONE durable channel that holds
   * ALL of that automation's runs (the runs-substrate rule: automation = one
   * channel for all its runs; playbook = one channel per run). Keyed on
   * `contextObjectType='automation' + contextObjectId=automationId` so every run
   * resolves the same room. `openRunSession` reuses the one active session per
   * channel, so sequential runs share this channel as distinct sessions (the
   * "AI responses inside" the automation's channel).
   *
   * A FEED channel is the intended vehicle — the schema's own `feedScope` doc
   * names "automation results" as the workspace-feed use. Resolver-only (no
   * unique index yet): the oldest-wins read keeps it deterministic if a rare
   * first-run race ever inserts two.
   */
  /**
   * The LOOKUP half of `ensureAutomationRunChannel` — the existing per-type run
   * channel for an automation, or `undefined` on a miss. NEVER creates. Extracted
   * so read-only callers (e.g. the atlas `feedTargets` resolver) can ask "which
   * channel does this automation's runs land in?" without ever spawning one.
   * `ensureAutomationRunChannel` calls this then creates on miss — same behavior.
   */
  async findAutomationRunChannel(
    automationId: string
  ): Promise<Channel | undefined> {
    const [existing] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.contextObjectType, "automation"),
          eq(channels.contextObjectId, automationId),
          eq(channels.status, ChannelStatus.ACTIVE)
        )
      )
      .orderBy(asc(channels.createdAt))
      .limit(1);

    return existing;
  }

  async ensureAutomationRunChannel(
    automationId: string,
    ownerId: string,
    workspaceId?: string,
    title?: string
  ): Promise<Channel> {
    const existing = await this.findAutomationRunChannel(automationId);
    if (existing) return existing;

    return await this.create({
      userId: ownerId,
      workspaceId,
      title: title ? `Runs · ${title}` : undefined,
      channelType: ChannelType.FEED,
      scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
      feedScope: workspaceId ? FeedScope.WORKSPACE : FeedScope.USER,
      contextObjectType: "automation",
      contextObjectId: automationId,
    });
  }

  /** Lookup the active RUN channel for (flowType, flowId), if any. */
  async findRunChannel(
    flowType: string,
    flowId: string
  ): Promise<Channel | undefined> {
    const [existing] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.contextObjectType, flowType),
          eq(channels.contextObjectId, flowId),
          eq(channels.channelType, ChannelType.RUN),
          eq(channels.status, ChannelStatus.ACTIVE)
        )
      )
      .orderBy(asc(channels.createdAt))
      .limit(1);
    return existing;
  }

  /**
   * Get or create the RUN channel for a process instance (capture, import, …).
   * Keyed on contextObjectType=flowType + contextObjectId=flowId.
   * Requires an active orchestrator agent so free-text can flip to an agent turn.
   */
  async ensureRunChannel(
    flowType: string,
    flowId: string,
    ownerId: string,
    opts?: {
      workspaceId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Channel> {
    const existing = await this.findRunChannel(flowType, flowId);
    if (existing) return existing;

    const [orchestrator] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
      .limit(1);

    if (!orchestrator?.id) {
      throw new Error(
        "ensureRunChannel: no active orchestrator agent — cannot open a process channel"
      );
    }

    try {
      return await this.create({
        userId: ownerId,
        workspaceId: opts?.workspaceId,
        title: opts?.title ?? `Run · ${flowType}`,
        channelType: ChannelType.RUN,
        scope: opts?.workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
        contextObjectType: flowType,
        contextObjectId: flowId,
        assignedAgentId: orchestrator.id,
        metadata: {
          purpose: "run",
          flowType,
          flowId,
          ...(opts?.metadata ?? {}),
        },
      });
    } catch (err) {
      // Race: another creator won — re-select the oldest active run channel.
      if (isUniqueViolation(err)) {
        const raced = await this.findRunChannel(flowType, flowId);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * The ONE door to an object's linked channel — its "object room" (Documents
   * v2, founder model 2026-09-25): every document / entity has exactly ONE
   * conversation, and a comment on it is an anchored message in that room.
   *
   * - Keyed per OBJECT, never per user or per workspace: the room is the
   *   object's, so its owner is the OBJECT's owner and its workspace the
   *   object's own. Who may read it is the object's read floor (branch 5 of
   *   `channelVisibilityWhere`), not the room's workspace.
   * - Race-safe: the partial unique index `channels_object_room_uniq`
   *   (migration 0279) is the arbiter — insert ON CONFLICT DO NOTHING, then
   *   re-select, so two concurrent opens converge on one row.
   * - NO access check here: this package cannot see the access layer. A HUMAN
   *   or agent door must floor the caller on the object first (the api's
   *   `ensureObjectChannelFor`). System producers (automation recaps) call it
   *   directly — they already act for the run.
   *
   * Returns `null` when the object does not exist (or is deleted).
   */
  async ensureObjectChannel(ref: {
    type: ObjectRoomType;
    id: string;
    title?: string;
  }): Promise<{ channel: Channel; created: boolean } | null> {
    const find = async () => {
      const [row] = await this.db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.channelType, ChannelType.GROUP),
            eq(channels.status, ChannelStatus.ACTIVE),
            eq(channels.contextObjectType, ref.type),
            eq(channels.contextObjectId, ref.id)
          )
        )
        .limit(1);
      return row as Channel | undefined;
    };

    const existing = await find();
    if (existing) return { channel: existing, created: false };

    const owner = await this.objectOwner(ref);
    if (!owner) return null;

    const inserted = await this.db
      .insert(channels)
      .values({
        id: crypto.randomUUID(),
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        title: ref.title ?? owner.title ?? undefined,
        channelType: ChannelType.GROUP,
        scope: owner.workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
        contextObjectType: ref.type,
        contextObjectId: ref.id,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "object-room" },
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      return { channel: inserted[0] as Channel, created: true };
    }
    // Lost the race — the winner's row is the room.
    const raced = await find();
    if (!raced) {
      throw new Error(
        `ensureObjectChannel: no room for ${ref.type}:${ref.id} after a conflicting insert`
      );
    }
    return { channel: raced, created: false };
  }

  /** The object's own owner + workspace (the room inherits both). */
  private async objectOwner(ref: {
    type: ObjectRoomType;
    id: string;
  }): Promise<{
    userId: string;
    workspaceId: string | null;
    title: string | null;
  } | null> {
    if (ref.type === "document") {
      const [doc] = await this.db
        .select({
          userId: documents.userId,
          workspaceId: documents.workspaceId,
          title: documents.title,
        })
        .from(documents)
        .where(and(eq(documents.id, ref.id), isNull(documents.deletedAt)))
        .limit(1);
      return doc ?? null;
    }
    const [entity] = await this.db
      .select({
        userId: entities.userId,
        workspaceId: entities.workspaceId,
        title: entities.title,
      })
      .from(entities)
      .where(and(eq(entities.id, ref.id), isNull(entities.deletedAt)))
      .limit(1);
    return entity ?? null;
  }

  /**
   * Get or create the user's MAIN personal AI thread — the orchestrator thread.
   *
   * Canonical resolver for jobs/system producers that want "the user's personal
   * channel" without knowing an agent id. It resolves the orchestrator agent and
   * delegates to ensurePersonalChannel, so the row carries assignedAgentId (and is
   * therefore covered by channels_user_agent_personal_uniq) and CONVERGES with the
   * api-side ensureAgentThread(userId, orchestratorId) on the same row. Never
   * inserts an agent-less personal channel (which the unique index would not
   * cover — the historical duplication vector).
   */
  async ensureUserPersonalChannel(userId: string): Promise<Channel> {
    const [orchestrator] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
      .limit(1);
    if (!orchestrator) {
      throw new Error(
        "ensureUserPersonalChannel: no active 'orchestrator' agent to key the personal thread on"
      );
    }
    return this.ensurePersonalChannel(userId, orchestrator.id);
  }

  /**
   * Emit completed event
   */
  private async emitCompleted(
    action: "create" | "update" | "delete",
    channelId: string,
    userId: string
  ): Promise<void> {
    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: `channels.${action}.completed`,
      subjectId: channelId,
      subjectType: "channel",
      data: { id: channelId },
      userId,
      source: "api",
      timestamp: new Date(),
      metadata: {},
    });
  }
}
