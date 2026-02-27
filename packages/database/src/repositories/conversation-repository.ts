/**
 * Conversation Repository - Chat History Management
 *
 * V0.4: Hash-chained conversation storage using postgres.js
 *
 * Features:
 * - Append messages with hash chain integrity
 * - Thread management
 * - Branching conversations
 * - Hash verification
 */

import { sql } from "../client-pg.js";
import { createHash, randomUUID } from "crypto";
import type { ConversationMessageMetadata } from "@synap-core/core";
import { MessageRole } from "../schema/messages.js";

// re-export so existing callers that import MessageRole from this module keep working
export { MessageRole };

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationMessage {
  id: string;
  channelId: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  metadata?: ConversationMessageMetadata | null;
  userId: string;
  timestamp: Date;
  previousHash: string | null;
  hash: string;
  deletedAt: Date | null;
}

export interface AppendMessageData {
  channelId: string;
  parentId?: string;
  role: MessageRole;
  content: string;
  metadata?: ConversationMessageMetadata | null;
  userId: string;
}

export interface ThreadInfo {
  channelId: string;
  messageCount: number;
  latestMessage: ConversationMessage | null;
  branches: number;
}

// ============================================================================
// CONVERSATION REPOSITORY
// ============================================================================

export class ConversationRepository {
  /**
   * Append message to conversation with hash chain
   */
  async appendMessage(data: AppendMessageData): Promise<ConversationMessage> {
    const messageId = randomUUID();

    // Get parent's hash if this is a reply
    let previousHash: string | null = null;
    if (data.parentId) {
      const parentResult = await sql`
        SELECT hash FROM messages WHERE id = ${data.parentId}
      `;

      if (parentResult.length === 0) {
        throw new Error(`Parent message ${data.parentId} not found`);
      }

      previousHash = parentResult[0].hash;
    }

    // Calculate hash for this message
    const hash = this.calculateHash({
      id: messageId,
      content: data.content,
      role: data.role,
      timestamp: new Date(),
      previousHash,
    });

    // Insert message
    const result = await sql`
      INSERT INTO messages (
        id,
        channel_id,
        parent_id,
        role,
        content,
        metadata,
        user_id,
        timestamp,
        previous_hash,
        hash
      ) VALUES (
        ${messageId},
        ${data.channelId},
        ${data.parentId || null},
        ${data.role},
        ${data.content},
        ${data.metadata ? JSON.stringify(data.metadata) : null},
        ${data.userId},
        NOW(),
        ${previousHash},
        ${hash}
      )
      RETURNING *
    `;

    return this.mapRow(result[0]);
  }

  /**
   * Get thread history (all messages in order)
   */
  async getThreadHistory(
    channelId: string,
    limit: number = 100
  ): Promise<ConversationMessage[]> {
    const result = await sql`
      SELECT * FROM messages
      WHERE channel_id = ${channelId}
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `;

    return result.map((row) => this.mapRow(row));
  }

  /**
   * Get latest message in thread
   */
  async getLatestMessage(
    channelId: string
  ): Promise<ConversationMessage | null> {
    const result = await sql`
      SELECT * FROM messages
      WHERE channel_id = ${channelId}
        AND deleted_at IS NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    return result.length > 0 ? this.mapRow(result[0]) : null;
  }

  /**
   * Create new branch from a message
   */
  async createBranch(parentMessageId: string, userId: string): Promise<string> {
    // Verify parent exists
    const parentResult = await sql`
      SELECT * FROM messages WHERE id = ${parentMessageId}
    `;

    if (parentResult.length === 0) {
      throw new Error(`Parent message ${parentMessageId} not found`);
    }

    const parent = this.mapRow(parentResult[0]);

    // Verify user owns the conversation
    if (parent.userId !== userId) {
      throw new Error(
        "Unauthorized: Cannot branch another user's conversation"
      );
    }

    // Create new channel ID for the branch
    const newChannelId = randomUUID();

    // Copy all messages up to (and including) the parent into the new channel
    await sql`
      INSERT INTO messages (
        id,
        channel_id,
        parent_id,
        role,
        content,
        metadata,
        user_id,
        timestamp,
        previous_hash,
        hash
      )
      SELECT
        gen_random_uuid(),
        ${newChannelId},
        parent_id,
        role,
        content,
        metadata,
        user_id,
        timestamp,
        previous_hash,
        hash
      FROM messages
      WHERE channel_id = ${parent.channelId}
        AND timestamp <= (SELECT timestamp FROM messages WHERE id = ${parentMessageId})
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
    `;

    return newChannelId;
  }

  /**
   * Get branches from a parent message
   */
  async getBranches(parentId: string): Promise<ConversationMessage[]> {
    const result = await sql`
      SELECT * FROM messages
      WHERE parent_id = ${parentId}
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
    `;

    return result.map((row) => this.mapRow(row));
  }

  /**
   * Verify hash chain integrity
   */
  async verifyHashChain(channelId: string): Promise<{
    isValid: boolean;
    brokenAt: string | null;
    message: string;
  }> {
    const result = await sql`
      SELECT * FROM verify_hash_chain(${channelId})
    `;

    const row = result[0];
    return {
      isValid: row.is_valid,
      brokenAt: row.broken_at,
      message: row.message,
    };
  }

  /**
   * Get thread info (metadata)
   */
  async getThreadInfo(channelId: string): Promise<ThreadInfo> {
    const countResult = await sql`
      SELECT count_thread_messages(${channelId}) as count
    `;

    const latestMessage = await this.getLatestMessage(channelId);

    // Count branches (messages with multiple children)
    const branchResult = await sql`
      SELECT COUNT(DISTINCT parent_id) as branches
      FROM (
        SELECT parent_id, COUNT(*) as children
        FROM messages
        WHERE channel_id = ${channelId}
          AND parent_id IS NOT NULL
          AND deleted_at IS NULL
        GROUP BY parent_id
        HAVING COUNT(*) > 1
      ) branching_points
    `;

    return {
      channelId,
      messageCount: countResult[0].count,
      latestMessage,
      branches: branchResult[0].branches || 0,
    };
  }

  /**
   * Get user's recent threads
   */
  async getUserThreads(
    userId: string,
    limit: number = 20
  ): Promise<
    Array<{
      channelId: string;
      latestMessage: ConversationMessage;
      messageCount: number;
    }>
  > {
    const result = await sql`
      WITH channel_latest AS (
        SELECT DISTINCT ON (channel_id)
          channel_id,
          id,
          content,
          timestamp
        FROM messages
        WHERE user_id = ${userId}
          AND deleted_at IS NULL
        ORDER BY channel_id, timestamp DESC
      ),
      channel_counts AS (
        SELECT
          channel_id,
          COUNT(*) as message_count
        FROM messages
        WHERE user_id = ${userId}
          AND deleted_at IS NULL
        GROUP BY channel_id
      )
      SELECT
        cl.*,
        cc.message_count,
        m.*
      FROM channel_latest cl
      JOIN channel_counts cc ON cl.channel_id = cc.channel_id
      JOIN messages m ON cl.id = m.id
      ORDER BY cl.timestamp DESC
      LIMIT ${limit}
    `;

    return result.map((row) => ({
      channelId: row.channel_id,
      messageCount: parseInt(row.message_count, 10),
      latestMessage: this.mapRow(row),
    }));
  }

  /**
   * Soft delete message
   */
  async deleteMessage(messageId: string, userId: string): Promise<void> {
    const result = await sql`
      UPDATE messages
      SET deleted_at = NOW()
      WHERE id = ${messageId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      RETURNING id
    `;

    if (result.length === 0) {
      throw new Error("Message not found or already deleted");
    }
  }

  /**
   * Calculate SHA256 hash for message
   */
  private calculateHash(data: {
    id: string;
    content: string;
    role: MessageRole;
    timestamp: Date;
    previousHash: string | null;
  }): string {
    const payload = JSON.stringify({
      id: data.id,
      content: data.content,
      role: data.role,
      timestamp: data.timestamp.toISOString(),
      previousHash: data.previousHash,
    });

    return createHash("sha256").update(payload).digest("hex");
  }

  /**
   * Map database row to ConversationMessage
   */
  private mapRow(row: Record<string, any>): ConversationMessage {
    const metadataValue = row.metadata
      ? typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata
      : null;

    return {
      id: row.id,
      channelId: row.channel_id,
      parentId: row.parent_id,
      role: row.role as MessageRole,
      content: row.content,
      metadata: metadataValue as ConversationMessageMetadata | null,
      userId: row.user_id,
      timestamp: new Date(row.timestamp),
      previousHash: row.previous_hash,
      hash: row.hash,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    };
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

let _conversationRepository: ConversationRepository | null = null;

export function getConversationRepository(): ConversationRepository {
  if (!_conversationRepository) {
    _conversationRepository = new ConversationRepository();
  }
  return _conversationRepository;
}

export const conversationRepository = getConversationRepository();
