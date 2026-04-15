/**
 * Message Links Repository
 *
 * Handles message link CRUD operations.
 * Note: Does NOT extend BaseRepository (links are not entities, no events needed).
 */

import {
  messageLinks,
  messages,
  type MessageLink,
  type NewMessageLink,
} from "../schema/index.js";
import { eq, and, inArray, desc, lt, or, isNull } from "drizzle-orm";

export interface CreateMessageLinkInput {
  messageId: string;
  targetType: string; // "entity" | "document" | "proposal" | ...
  targetId: string;
  relationshipType: string; // "created" | "updated" | "references" | ...
  position?: { start: number; end: number };
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId?: string | null;
}

export interface QueryMessageLinksInput {
  messageId?: string;
  targetType?: string;
  targetId?: string;
  relationshipType?: string;
  workspaceId?: string;
}

/** Options for getByTargetWithMessages */
export interface GetByTargetWithMessagesOptions {
  limit?: number;
  cursor?: string; // opaque: "createdAt:linkId" for next page
}

/** Minimal message fields for list/preview */
export interface LinkedMessagePreview {
  id: string;
  channelId: string;
  role: string;
  content: string;
  timestamp: Date;
  userId: string;
}

export interface LinkedMessageItem {
  link: MessageLink;
  message: LinkedMessagePreview;
}

export class MessageLinksRepository {
  constructor(private db: any) {}

  /**
   * Create a message link
   */
  async create(input: CreateMessageLinkInput): Promise<MessageLink> {
    const [link] = await this.db
      .insert(messageLinks)
      .values({
        messageId: input.messageId,
        targetType: input.targetType,
        targetId: input.targetId,
        relationshipType: input.relationshipType,
        position: input.position || null,
        metadata: input.metadata || null,
        userId: input.userId,
        workspaceId: input.workspaceId,
      } as NewMessageLink)
      .returning();

    return link;
  }

  /**
   * Delete a message link
   */
  async delete(id: string): Promise<void> {
    await this.db.delete(messageLinks).where(eq(messageLinks.id, id));
  }

  /**
   * Delete all links for a message
   */
  async deleteByMessage(messageId: string): Promise<void> {
    await this.db
      .delete(messageLinks)
      .where(eq(messageLinks.messageId, messageId));
  }

  /**
   * Get all links for a message
   */
  async getByMessage(messageId: string): Promise<MessageLink[]> {
    return await this.db
      .select()
      .from(messageLinks)
      .where(eq(messageLinks.messageId, messageId))
      .orderBy(messageLinks.createdAt);
  }

  /**
   * Get all links to a target (e.g., all messages linked to a proposal)
   */
  async getByTarget(
    targetType: string,
    targetId: string
  ): Promise<MessageLink[]> {
    return await this.db
      .select()
      .from(messageLinks)
      .where(
        and(
          eq(messageLinks.targetType, targetType),
          eq(messageLinks.targetId, targetId)
        )
      )
      .orderBy(messageLinks.createdAt);
  }

  /**
   * Get all links to a target with joined message content (for "messages linked to this entity/document").
   * Excludes soft-deleted messages. Ordered by link createdAt desc. Supports cursor pagination.
   */
  async getByTargetWithMessages(
    targetType: string,
    targetId: string,
    workspaceId?: string | null,
    options: GetByTargetWithMessagesOptions = {}
  ): Promise<{
    items: LinkedMessageItem[];
    nextCursor: string | undefined;
    hasMore: boolean;
  }> {
    const { limit = 50, cursor } = options;
    const limitFetch = limit + 1;

    type Row = {
      link: typeof messageLinks.$inferSelect;
      id: string;
      channelId: string;
      role: string;
      content: string;
      timestamp: Date;
      userId: string;
    };

    const conditions = [
      eq(messageLinks.targetType, targetType),
      eq(messageLinks.targetId, targetId),
      isNull(messages.deletedAt),
    ];
    if (workspaceId) {
      conditions.push(eq(messageLinks.workspaceId, workspaceId));
    }

    if (cursor) {
      try {
        const [cursorDateStr, cursorLinkId] = cursor.split(":");
        const cursorDate = new Date(cursorDateStr);
        conditions.push(
          or(
            lt(messageLinks.createdAt, cursorDate),
            and(
              eq(messageLinks.createdAt, cursorDate),
              lt(messageLinks.id, cursorLinkId)
            )
          )!
        );
      } catch {
        // invalid cursor: ignore
      }
    }

    const rows = await this.db
      .select({
        link: messageLinks,
        id: messages.id,
        channelId: messages.channelId,
        role: messages.role,
        content: messages.content,
        timestamp: messages.timestamp,
        userId: messages.userId,
      })
      .from(messageLinks)
      .innerJoin(messages, eq(messageLinks.messageId, messages.id))
      .where(and(...conditions))
      .orderBy(desc(messageLinks.createdAt))
      .limit(limitFetch);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(
      (row: Row): LinkedMessageItem => ({
        link: row.link,
        message: {
          id: row.id,
          channelId: row.channelId,
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
          userId: row.userId,
        },
      })
    );

    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? `${last.link.createdAt.toISOString()}:${last.link.id}`
        : undefined;

    return { items, nextCursor, hasMore };
  }

  /**
   * Get links by relationship type (e.g., all approval messages for a proposal)
   */
  async getByRelationship(
    targetType: string,
    targetId: string,
    relationshipType: string
  ): Promise<MessageLink[]> {
    return await this.db
      .select()
      .from(messageLinks)
      .where(
        and(
          eq(messageLinks.targetType, targetType),
          eq(messageLinks.targetId, targetId),
          eq(messageLinks.relationshipType, relationshipType)
        )
      )
      .orderBy(messageLinks.createdAt);
  }

  /**
   * Get approval chain for a proposal (all approves/rejects/comments)
   */
  async getApprovalChain(proposalId: string): Promise<MessageLink[]> {
    return await this.db
      .select()
      .from(messageLinks)
      .where(
        and(
          eq(messageLinks.targetType, "proposal"),
          eq(messageLinks.targetId, proposalId),
          inArray(messageLinks.relationshipType, [
            "approves",
            "rejects",
            "comments",
          ])
        )
      )
      .orderBy(messageLinks.createdAt);
  }

  /**
   * Query message links with filters
   */
  async query(input: QueryMessageLinksInput): Promise<MessageLink[]> {
    const conditions = [];

    if (input.messageId) {
      conditions.push(eq(messageLinks.messageId, input.messageId));
    }
    if (input.targetType) {
      conditions.push(eq(messageLinks.targetType, input.targetType));
    }
    if (input.targetId) {
      conditions.push(eq(messageLinks.targetId, input.targetId));
    }
    if (input.relationshipType) {
      conditions.push(
        eq(messageLinks.relationshipType, input.relationshipType)
      );
    }
    if (input.workspaceId) {
      conditions.push(eq(messageLinks.workspaceId, input.workspaceId));
    }

    return await this.db
      .select()
      .from(messageLinks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(messageLinks.createdAt);
  }
}
