/**
 * Conversation Repository - Chat History Management
 * 
 * V0.4: Hash-chained conversation storage
 * 
 * Features:
 * - Append messages with hash chain integrity
 * - Thread management
 * - Branching conversations
 * - Hash verification
 */

import { Pool } from '@neondatabase/serverless';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import type { ConversationMessageMetadata } from '@synap/core';

// ============================================================================
// TYPES
// ============================================================================

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export interface ConversationMessage {
  id: string;
  threadId: string;
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
  threadId: string;
  parentId?: string;
  role: MessageRole;
  content: string;
  metadata?: ConversationMessageMetadata | null;
  userId: string;
}

export interface ThreadInfo {
  threadId: string;
  messageCount: number;
  latestMessage: ConversationMessage | null;
  branches: number;
}

// ============================================================================
// CONVERSATION REPOSITORY
// ============================================================================

export class ConversationRepository {
  constructor(private pool: Pool) {}

  /**
   * Append message to conversation with hash chain
   */
  async appendMessage(data: AppendMessageData): Promise<ConversationMessage> {
    const messageId = randomUUID();
    
    // Get parent's hash if this is a reply
    let previousHash: string | null = null;
    if (data.parentId) {
      const parentResult = await this.pool.query(
        'SELECT hash FROM conversation_messages WHERE id = $1',
        [data.parentId]
      );
      
      if (parentResult.rows.length === 0) {
        throw new Error(`Parent message ${data.parentId} not found`);
      }
      
      previousHash = parentResult.rows[0].hash;
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
    const result = await this.pool.query(`
      INSERT INTO conversation_messages (
        id,
        thread_id,
        parent_id,
        role,
        content,
        metadata,
        user_id,
        timestamp,
        previous_hash,
        hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
      RETURNING *
    `, [
      messageId,
      data.threadId,
      data.parentId || null,
      data.role,
      data.content,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.userId,
      previousHash,
      hash,
    ]);
    
    return this.mapRow(result.rows[0]);
  }

  /**
   * Get thread history (all messages in order)
   */
  async getThreadHistory(
    threadId: string,
    limit: number = 100
  ): Promise<ConversationMessage[]> {
    const result = await this.pool.query(`
      SELECT * FROM conversation_messages
      WHERE thread_id = $1
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
      LIMIT $2
    `, [threadId, limit]);
    
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get latest message in thread
   */
  async getLatestMessage(threadId: string): Promise<ConversationMessage | null> {
    const result = await this.pool.query(`
      SELECT * FROM conversation_messages
      WHERE thread_id = $1
        AND deleted_at IS NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `, [threadId]);
    
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Create new branch from a message
   */
  async createBranch(
    parentMessageId: string,
    userId: string
  ): Promise<string> {
    // Verify parent exists
    const parentResult = await this.pool.query(
      'SELECT * FROM conversation_messages WHERE id = $1',
      [parentMessageId]
    );
    
    if (parentResult.rows.length === 0) {
      throw new Error(`Parent message ${parentMessageId} not found`);
    }
    
    const parent = this.mapRow(parentResult.rows[0]);
    
    // Verify user owns the conversation
    if (parent.userId !== userId) {
      throw new Error('Unauthorized: Cannot branch another user\'s conversation');
    }
    
    // Create new thread ID
    const newThreadId = randomUUID();
    
    // Copy all messages up to (and including) the parent into new thread
    await this.pool.query(`
      INSERT INTO conversation_messages (
        id,
        thread_id,
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
        $1,  -- New thread ID
        parent_id,
        role,
        content,
        metadata,
        user_id,
        timestamp,
        previous_hash,
        hash
      FROM conversation_messages
      WHERE thread_id = $2
        AND timestamp <= (SELECT timestamp FROM conversation_messages WHERE id = $3)
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
    `, [newThreadId, parent.threadId, parentMessageId]);
    
    return newThreadId;
  }

  /**
   * Get branches from a parent message
   */
  async getBranches(parentId: string): Promise<ConversationMessage[]> {
    const result = await this.pool.query(`
      SELECT * FROM conversation_messages
      WHERE parent_id = $1
        AND deleted_at IS NULL
      ORDER BY timestamp ASC
    `, [parentId]);
    
    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Verify hash chain integrity
   */
  async verifyHashChain(threadId: string): Promise<{
    isValid: boolean;
    brokenAt: string | null;
    message: string;
  }> {
    const result = await this.pool.query(
      'SELECT * FROM verify_hash_chain($1)',
      [threadId]
    );
    
    const row = result.rows[0];
    return {
      isValid: row.is_valid,
      brokenAt: row.broken_at,
      message: row.message,
    };
  }

  /**
   * Get thread info (metadata)
   */
  async getThreadInfo(threadId: string): Promise<ThreadInfo> {
    const countResult = await this.pool.query(
      'SELECT count_thread_messages($1) as count',
      [threadId]
    );
    
    const latestMessage = await this.getLatestMessage(threadId);
    
    // Count branches (messages with multiple children)
    const branchResult = await this.pool.query(`
      SELECT COUNT(DISTINCT parent_id) as branches
      FROM (
        SELECT parent_id, COUNT(*) as children
        FROM conversation_messages
        WHERE thread_id = $1
          AND parent_id IS NOT NULL
          AND deleted_at IS NULL
        GROUP BY parent_id
        HAVING COUNT(*) > 1
      ) branching_points
    `, [threadId]);
    
    return {
      threadId,
      messageCount: countResult.rows[0].count,
      latestMessage,
      branches: branchResult.rows[0].branches || 0,
    };
  }

  /**
   * Get user's recent threads
   */
  async getUserThreads(
    userId: string,
    limit: number = 20
  ): Promise<Array<{
    threadId: string;
    latestMessage: ConversationMessage;
    messageCount: number;
  }>> {
    const result = await this.pool.query(`
      WITH thread_latest AS (
        SELECT DISTINCT ON (thread_id)
          thread_id,
          id,
          content,
          timestamp
        FROM conversation_messages
        WHERE user_id = $1
          AND deleted_at IS NULL
        ORDER BY thread_id, timestamp DESC
      ),
      thread_counts AS (
        SELECT
          thread_id,
          COUNT(*) as message_count
        FROM conversation_messages
        WHERE user_id = $1
          AND deleted_at IS NULL
        GROUP BY thread_id
      )
      SELECT
        tl.*,
        tc.message_count,
        cm.*
      FROM thread_latest tl
      JOIN thread_counts tc ON tl.thread_id = tc.thread_id
      JOIN conversation_messages cm ON tl.id = cm.id
      ORDER BY tl.timestamp DESC
      LIMIT $2
    `, [userId, limit]);
    
    return result.rows.map(row => ({
      threadId: row.thread_id,
      messageCount: parseInt(row.message_count, 10),
      latestMessage: this.mapRow(row),
    }));
  }

  /**
   * Soft delete message
   */
  async deleteMessage(messageId: string, userId: string): Promise<void> {
    const result = await this.pool.query(`
      UPDATE conversation_messages
      SET deleted_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
      RETURNING id
    `, [messageId, userId]);
    
    if (result.rows.length === 0) {
      throw new Error('Message not found or already deleted');
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
    
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Map database row to ConversationMessage
   */
  private mapRow(row: Record<string, any>): ConversationMessage {
    const metadataValue = row.metadata
      ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata)
      : null;

    return {
      id: row.id,
      threadId: row.thread_id,
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
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    _conversationRepository = new ConversationRepository(pool);
  }
  return _conversationRepository;
}

export const conversationRepository = getConversationRepository();

