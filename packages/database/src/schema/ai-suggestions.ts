/**
 * AI Suggestions Schema
 * 
 * Stores AI-generated suggestions for users.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, jsonb, real, timestamp } from 'drizzle-orm/pg-core';

export const aiSuggestions = pgTable('ai_suggestions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  status: text('status').default('pending').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  payload: jsonb('payload'),
  confidence: real('confidence').default(0.5).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});


export type AISuggestionRow = typeof aiSuggestions.$inferSelect;
export type NewAISuggestionRow = typeof aiSuggestions.$inferInsert;




