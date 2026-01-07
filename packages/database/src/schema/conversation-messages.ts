/**
 * Conversation Messages Schema
 * 
 * Stores conversation messages with hash chain for integrity.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import type { ConversationMessageMetadata } from '@synap-core/core';
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const conversationMessages = pgTable('conversation_messages', {
  // Identity
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Thread management
  threadId: uuid('thread_id').notNull(), // Conversation thread
  parentId: uuid('parent_id'),           // Parent message (for branching)
  
  // Message content
  role: text('role', { 
    enum: ['user', 'assistant', 'system'] 
  }).notNull(),
  content: text('content').notNull(),
  
  // Metadata (AI suggestions, sources, etc.)
  metadata: jsonb('metadata').$type<ConversationMessageMetadata | null>(),
  
  // Ownership
  userId: text('user_id').notNull(),
  
  // Timestamps
  timestamp: timestamp('timestamp', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
  
  // Hash chain (blockchain-like integrity)
  previousHash: text('previous_hash'), // Hash of parent message
  hash: text('hash').notNull(),        // SHA256 of this message
  
  // Soft delete
  deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
});


// Note: Main types exported from conversation-repository.ts to avoid conflicts
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type NewConversationMessageRow = typeof conversationMessages.$inferInsert;

