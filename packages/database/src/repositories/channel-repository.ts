/**
 * Channel Repository
 *
 * Standalone repository for channels.
 * Handles CRUD operations with event emission.
 */

import { eq, and, asc, desc, ne, isNull, sql as drizzleSql } from "drizzle-orm";
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
          eq(channels.status, ChannelStatus.ACTIVE)
        )
      )
      // Deterministic oldest-wins on duplicate feed channels.
      .orderBy(asc(channels.createdAt))
      .limit(1);

    if (existing) return existing;

    // Race-safe against channels_user_feed_uniq (migration 0182).
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
            eq(channels.status, ChannelStatus.ACTIVE)
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

  /**
   * Get or create THE channel for posting activity ABOUT an entity — the
   * WRITE-twin of the entity-bound channel READ used across the executor
   * (`contextObjectType='entity' + contextObjectId=entityId`, e.g.
   * `executeMessagesQueryStep`). This is the per-entity result-routing spine: it
   * lets a per-client automation post each run's recap into that client's own
   * room rather than one shared automation feed.
   *
   * REUSE-FIRST: if a channel is already bound to the entity we post INTO it
   * rather than spawning a new room — the whole point is the client's existing
   * discussion surface. We deliberately EXCLUDE `external` (client-comms)
   * channels from reuse: an automation recap is an INTERNAL, operator-facing
   * summary and must never land in the surface that mirrors back to the client
   * (`executeMessagesQueryStep` reads the EXTERNAL one precisely because it is
   * the client's comms). If only an external channel exists we create a fresh
   * internal thread instead.
   *
   * CREATED TYPE = THREAD bound to the entity — the natural "discussion about
   * this client" surface (mirrors `channels.createEntityComment`, which makes
   * exactly this THREAD+entity shape). Not a FEED: a per-client recap is a
   * conversation a teammate can reply in, not a read-only broadcast.
   *
   * Resolver-only (no unique index on the entity binding — same as
   * `ensureAutomationRunChannel`): the oldest-wins read keeps it deterministic if
   * a rare first-run race ever inserts two.
   */
  async ensureEntityChannel(
    entityId: string,
    ownerId: string,
    workspaceId?: string,
    opts?: { title?: string }
  ): Promise<Channel> {
    const [existing] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.contextObjectType, "entity"),
          eq(channels.contextObjectId, entityId),
          // Never route an internal recap into a client-comms surface.
          ne(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.status, ChannelStatus.ACTIVE),
          // Reuse ONLY within the requesting run's workspace scope. A pod-scoped
          // entity can be touched by automations in different workspaces; without
          // this, workspace Y's per-entity recap would reuse (and disclose into)
          // a channel workspace X created for the same entity — the channel
          // read-visibility gate is keyed on channels.workspaceId. So we scope
          // reuse per-workspace (pod-wide runs reuse the pod-scoped channel),
          // creating a fresh per-(entity, workspace) thread on a miss. Unlike
          // ensureAutomationRunChannel (automationId is single-workspace by
          // construction), the entity binding is not.
          workspaceId
            ? eq(channels.workspaceId, workspaceId)
            : isNull(channels.workspaceId)
        )
      )
      // Deterministic oldest-wins on duplicate entity-bound channels.
      .orderBy(asc(channels.createdAt))
      .limit(1);

    if (existing) return existing;

    return await this.create({
      userId: ownerId,
      workspaceId,
      title: opts?.title,
      channelType: ChannelType.THREAD,
      scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
      contextObjectType: "entity",
      contextObjectId: entityId,
    });
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
