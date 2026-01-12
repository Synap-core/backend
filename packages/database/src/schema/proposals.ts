import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

/**
 * Universal Proposals Table
 * 
 * Stores all pending update requests (proposals) for any entity type.
 * This effectively "pauses" an event until it is validated.
 */
export const proposals = pgTable('proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Scoping
  workspaceId: text('workspace_id').notNull(),
  
  // Categorization (for filtering hooks)
  targetType: text('target_type').notNull(), // 'document', 'entity', 'whiteboard', etc.
  targetId: text('target_id').notNull(),
  
  // The Proposal Content
  // Stores the full UpdateRequest object
  request: jsonb('request').notNull(),
  
  // Status Tracking
  status: text('status').notNull().default('pending'), // 'pending' | 'validated' | 'rejected'
  
  // Review Metadata
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Index for "My Pending Inbox"
  workspaceStatusIdx: index('idx_proposals_workspace_status')
    .on(table.workspaceId, table.status),
    
  // Index for "History of this Item"
  targetIdx: index('idx_proposals_target')
    .on(table.targetType, table.targetId),
}));

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;

// Zod Schemas
export const insertProposalSchema = createInsertSchema(proposals);
export const selectProposalSchema = createSelectSchema(proposals);
