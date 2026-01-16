/**
 * Inbox Repository
 *
 * Handles all inbox item CRUD operations with automatic event emission
 *
 * Note: Inbox items have a complex schema with provider-specific fields.
 * This repository provides a simplified interface.
 */

import { eq, and } from "drizzle-orm";
import { inboxItems } from "../schema/inbox-items.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { InboxItem, NewInboxItem } from "../schema/inbox-items.js";

export interface CreateInboxItemInput {
  id?: string;
  userId: string;
  provider: string;
  account: string;
  externalId: string;
  type: string;
  title: string;
  preview?: string;
  timestamp: Date;
  status?: "unread" | "read" | "archived" | "snoozed";
  deepLink?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  tags?: string[];
  data?: Record<string, unknown>;
}

export interface UpdateInboxItemInput {
  title?: string;
  preview?: string;
  status?: "unread" | "read" | "archived" | "snoozed";
  priority?: "urgent" | "high" | "normal" | "low";
  tags?: string[];
  snoozedUntil?: Date;
  data?: Record<string, unknown>;
}

export class InboxRepository extends BaseRepository<
  InboxItem,
  CreateInboxItemInput,
  UpdateInboxItemInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, {
      subjectType: "inbox_item",
      pluralName: "inbox_items",
    });
  }

  /**
   * Create a new inbox item
   * Emits: inbox.create.completed
   */
  async create(data: CreateInboxItemInput, userId: string): Promise<InboxItem> {
    const [item] = await this.db
      .insert(inboxItems)
      .values({
        id: data.id,
        userId: data.userId,
        workspaceId: data.userId, // TODO: Get from event/context
        provider: data.provider,
        account: data.account,
        externalId: data.externalId,
        type: data.type,
        title: data.title,
        preview: data.preview,
        timestamp: data.timestamp,
        status: data.status || "unread",
        deepLink: data.deepLink,
        priority: data.priority,
        tags: data.tags,
        data: data.data || {},
      } as NewInboxItem)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", item, userId);

    return item;
  }

  /**
   * Update an existing inbox item
   * Emits: inbox.update.completed
   */
  async update(
    id: string,
    data: UpdateInboxItemInput,
    userId: string
  ): Promise<InboxItem> {
    const [item] = await this.db
      .update(inboxItems)
      .set({
        title: data.title,
        preview: data.preview,
        status: data.status,
        priority: data.priority,
        tags: data.tags,
        snoozedUntil: data.snoozedUntil,
        data: data.data,
        updatedAt: new Date(),
      } as Partial<NewInboxItem>)
      .where(and(eq(inboxItems.id, id), eq(inboxItems.userId, userId)))
      .returning();

    if (!item) {
      throw new Error("Inbox item not found");
    }

    // Emit completed event
    await this.emitCompleted("update", item, userId);

    return item;
  }

  /**
   * Delete an inbox item
   * Emits: inbox.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(inboxItems)
      .where(and(eq(inboxItems.id, id), eq(inboxItems.userId, userId)))
      .returning({ id: inboxItems.id });

    if (result.length === 0) {
      throw new Error("Inbox item not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
