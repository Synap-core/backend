/**
 * Conversation Messages Schema - The Source of INTENTION
 * 
 * V0.4: Hash-chained conversation history
 * 
 * This is the PRIMARY source of truth. It captures:
 * - User intent (WHY actions were taken)
 * - AI reasoning (HOW decisions were made)
 * - Branching discussions (WHAT-IF scenarios)
 * 
 * The hash chain ensures:
 * - Immutability (tamper detection)
 * - Verifiable ordering
 * - Branch integrity
 */

import { randomUUID } from 'crypto';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let conversationMessages: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, text, timestamp, jsonb } = require('drizzle-orm/pg-core');
  
  conversationMessages = pgTable('conversation_messages', {
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
    metadata: jsonb('metadata') as any,
    
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
} else {
  // SQLite schema (single-user, no hash chain needed)
  const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
  
  conversationMessages = sqliteTable('conversation_messages', {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    threadId: text('thread_id').notNull(),
    parentId: text('parent_id'),
    
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    metadata: text('metadata', { mode: 'json' }),
    
    userId: text('user_id').notNull(),
    
    timestamp: integer('timestamp', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    
    previousHash: text('previous_hash'),
    hash: text('hash').notNull(),
    
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  });
}

export { conversationMessages };

// Note: Main types exported from conversation-repository.ts to avoid conflicts
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type NewConversationMessageRow = typeof conversationMessages.$inferInsert;

