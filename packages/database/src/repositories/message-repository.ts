/**
 * Message Repository
 *
 * Handles messages CRUD with event emission
 */

import type { EventRepository } from "./event-repository.js";
import { messages } from "../schema/index.js";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

export type Message = typeof messages.$inferSelect;

export class MessageRepository {
  constructor(
    private db: any,
    private eventRepo: EventRepository
  ) {}

  async delete(id: string, userId: string): Promise<void> {
    await this.db.delete(messages).where(eq(messages.id, id));

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
