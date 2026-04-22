/**
 * Channel Repository
 *
 * Standalone repository for channels.
 * Handles CRUD operations with event emission.
 */

import { eq, and, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  channels,
  type Channel,
  ChannelType,
  ChannelScope,
  FeedScope,
  ThreadKind,
  ChannelStatus,
} from "../schema/channels.js";
import { EventRepository } from "./event-repository.js";
import { sql } from "../client-pg.js";

export interface CreateChannelData {
  id?: string;
  userId: string;
  workspaceId?: string;
  title?: string;
  channelType?: ChannelType;
  contextObjectType?: string;
  contextObjectId?: string;
  threadKind?: ThreadKind;
  parentChannelId?: string;
  branchedFromMessageId?: string;
  branchPurpose?: string;
  senderAgentId?: string;
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

  constructor(
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ) {
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
        threadKind: data.threadKind,
        parentChannelId: data.parentChannelId,
        branchedFromMessageId: data.branchedFromMessageId,
        branchPurpose: data.branchPurpose,
        senderAgentId: data.senderAgentId || null,
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
    _workspaceId?: string
  ): Promise<Channel> {
    const [existing] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.THREAD),
          eq(channels.threadKind, ThreadKind.PERSONAL),
          eq(channels.status, ChannelStatus.ACTIVE)
        )
      )
      .limit(1);

    if (existing) return existing;

    return this.create({
      userId,
      workspaceId: undefined, // pod-wide
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.PERSONAL,
      scope: ChannelScope.POD,
      senderAgentId: undefined,
    });
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
      .limit(1);

    if (existing) return existing;

    return this.create({
      userId,
      workspaceId: undefined, // pod-wide
      channelType: ChannelType.FEED,
      scope: ChannelScope.POD,
      feedScope: FeedScope.USER,
      senderAgentId: undefined,
    });
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
