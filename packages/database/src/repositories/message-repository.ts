/**
 * Message Repository
 *
 * Handles messages CRUD with event emission
 */

import type { EventRepository } from "./event-repository.js";
import { conversationMessages } from "../schema/index.js";
import { randomUUID, createHash } from "crypto";
import { eq } from "drizzle-orm";

export interface CreateMessageInput {
  threadId: string;
  content: string;
  role: "user" | "assistant" | "system";
  parentId?: string;
  attachments?: any[];
  metadata?: Record<string, unknown>;
  userId: string;
}

export type Message = typeof conversationMessages.$inferSelect;

export class MessageRepository {
  constructor(
    private db: any,
    private eventRepo: EventRepository
  ) {}

  async create(input: CreateMessageInput, userId: string): Promise<Message> {
    const messageId = randomUUID();

    // Compute hash
    const hashInput = JSON.stringify({
      threadId: input.threadId,
      content: input.content,
      role: input.role,
      timestamp: new Date().toISOString(),
    });
    const hash = createHash("sha256").update(hashInput).digest("hex");

    const [message] = await this.db
      .insert(conversationMessages)
      .values({
        id: messageId,
        threadId: input.threadId,
        parentId: input.parentId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ? input.metadata : null,
        userId: input.userId,
        timestamp: new Date(),
        hash,
      } as any)
      .returning();

    await this.eventRepo.append({
      id: randomUUID(),
      version: "v1",
      type: `messages.create.completed`,
      subjectId: messageId,
      subjectType: "message",
      userId,
      source: "api",
      timestamp: new Date(),
      data: { messageId, threadId: input.threadId },
      metadata: {},
    });

    return message;
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .delete(conversationMessages)
      .where(eq(conversationMessages.id, id));

    await this.eventRepo.append({
      id: randomUUID(),
      version: "v1",
      type: `messages.delete.completed`,
      subjectId: id,
      subjectType: "message",
      userId,
      source: "api",
      timestamp: new Date(),
      data: { id },
      metadata: {},
    });
  }
}
