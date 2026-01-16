/**
 * Chat Thread Repository
 *
 * Standalone repository for chat threads.
 * Handles CRUD operations with event emission.
 */

import { eq, and, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chatThreads, type ChatThread } from "../schema/chat-threads.js";
import { EventRepository } from "./event-repository.js";

export interface CreateChatThreadData {
  id?: string;
  userId: string;
  projectId?: string;
  title?: string;
  threadType?: "main" | "branch";
  parentThreadId?: string;
  branchedFromMessageId?: string;
  branchPurpose?: string;
  agentId?: string;
  agentType?:
    | "default"
    | "meta"
    | "prompting"
    | "knowledge-search"
    | "code"
    | "writing"
    | "action";
  agentConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateChatThreadData {
  title?: string;
  status?: "active" | "merged" | "archived";
  contextSummary?: string;
  metadata?: Record<string, unknown>;
  mergedAt?: Date;
}

export class ChatThreadRepository {
  private eventRepo: EventRepository;

  constructor(private db: NodePgDatabase<any>) {
    this.eventRepo = new EventRepository(db as any);
  }

  /**
   * Create a new chat thread
   */
  async create(data: CreateChatThreadData): Promise<ChatThread> {
    const { randomUUID } = await import("crypto");
    const threadId = data.id || randomUUID();

    const [thread] = await this.db
      .insert(chatThreads)
      .values({
        id: threadId,
        userId: data.userId,
        projectId: data.projectId,
        title: data.title,
        threadType: data.threadType || "main",
        parentThreadId: data.parentThreadId,
        branchedFromMessageId: data.branchedFromMessageId,
        branchPurpose: data.branchPurpose,
        agentId: data.agentId || "orchestrator",
        agentType: data.agentType || "default",
        agentConfig: data.agentConfig,
        metadata: data.metadata,
        status: "active",
      })
      .returning();

    await this.emitCompleted("create", threadId, data.userId);
    return thread;
  }

  /**
   * Update a chat thread
   */
  async update(
    id: string,
    data: UpdateChatThreadData,
    userId: string
  ): Promise<ChatThread> {
    const [thread] = await this.db
      .update(chatThreads)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, id))
      .returning();

    if (!thread) {
      throw new Error(`Chat thread ${id} not found`);
    }

    await this.emitCompleted("update", id, userId);
    return thread;
  }

  /**
   * Delete a chat thread (soft delete)
   */
  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .update(chatThreads)
      .set({
        status: "archived",
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, id));

    await this.emitCompleted("delete", id, userId);
  }

  /**
   * Get a chat thread by ID
   */
  async getById(id: string): Promise<ChatThread | null> {
    const [thread] = await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, id))
      .limit(1);
    return thread || null;
  }

  /**
   * List user's chat threads
   */
  async listByUser(
    userId: string,
    filters?: {
      projectId?: string;
      status?: "active" | "merged" | "archived";
      threadType?: "main" | "branch";
    }
  ): Promise<ChatThread[]> {
    const conditions = [eq(chatThreads.userId, userId)];

    if (filters?.projectId) {
      conditions.push(eq(chatThreads.projectId, filters.projectId));
    }
    if (filters?.status) {
      conditions.push(eq(chatThreads.status, filters.status));
    }
    if (filters?.threadType) {
      conditions.push(eq(chatThreads.threadType, filters.threadType));
    }

    return await this.db
      .select()
      .from(chatThreads)
      .where(and(...conditions))
      .orderBy(desc(chatThreads.updatedAt));
  }

  /**
   * Get thread branches
   */
  async getBranches(parentThreadId: string): Promise<ChatThread[]> {
    return await this.db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.parentThreadId, parentThreadId))
      .orderBy(desc(chatThreads.createdAt));
  }

  /**
   * Merge a branch thread
   */
  async mergeBranch(
    branchId: string,
    contextSummary: string,
    userId: string
  ): Promise<ChatThread> {
    const [thread] = await this.db
      .update(chatThreads)
      .set({
        status: "merged",
        contextSummary,
        mergedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, branchId))
      .returning();

    if (!thread) {
      throw new Error(`Chat thread ${branchId} not found`);
    }

    await this.emitCompleted("update", branchId, userId);
    return thread;
  }

  /**
   * Emit completed event
   */
  private async emitCompleted(
    action: "create" | "update" | "delete",
    threadId: string,
    userId: string
  ): Promise<void> {
    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: `chat_threads.${action}.completed`,
      subjectId: threadId,
      subjectType: "chat_thread",
      data: { id: threadId },
      userId,
      source: "api",
      timestamp: new Date(),
      metadata: {},
    });
  }
}
