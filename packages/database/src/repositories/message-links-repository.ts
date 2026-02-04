/**
 * Message Links Repository
 *
 * Handles message link CRUD operations.
 * Note: Does NOT extend BaseRepository (links are not entities, no events needed).
 */

import {
  messageLinks,
  type MessageLink,
  type NewMessageLink,
} from "../schema/index.js";
import { eq, and, inArray } from "drizzle-orm";

export interface CreateMessageLinkInput {
  messageId: string;
  targetType: string; // "entity" | "document" | "proposal" | ...
  targetId: string;
  relationshipType: string; // "created" | "updated" | "references" | ...
  position?: { start: number; end: number };
  metadata?: Record<string, unknown>;
  userId: string;
  workspaceId: string;
}

export interface QueryMessageLinksInput {
  messageId?: string;
  targetType?: string;
  targetId?: string;
  relationshipType?: string;
  workspaceId?: string;
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
