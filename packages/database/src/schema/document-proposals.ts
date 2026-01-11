/**
 * Document Proposals Schema
 * For AI-suggested edits and review workflow
 */

import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { documents } from './documents.js';

/**
 * Document proposals table
 * Stores AI-suggested changes and user proposals awaiting review
 */
export const documentProposals = pgTable('document_proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  
  // Proposal metadata
  proposalType: text('proposal_type').notNull(), // 'ai_edit' | 'user_suggestion' | 'review_comment' | 'offline_sync_conflict'
  proposedBy: text('proposed_by').notNull(), // 'ai' | user_id
  
  // The actual changes (OT operations or JSON patch)
  changes: jsonb('changes').notNull(),
  /* Example:
  [
    { "op": "delete", "range": [0, 50] },
    { "op": "insert", "position": 0, "text": "New intro..." },
    { "op": "replace", "range": [100, 200], "text": "Updated section..." }
  ]
  */
  
  // Content snapshots for diff display
  originalContent: text('original_content'), // Content before changes
  proposedContent: text('proposed_content'), // Content after changes (computed)
  
  // Status tracking
  status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'rejected' | 'expired'
  
  // Review metadata
  reviewedBy: text('reviewed_by'), // user_id who accepted/rejected
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewComment: text('review_comment'),
  
  // Auto-expire old proposals (7 days default)
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  documentIdIdx: index('document_proposals_document_id_idx').on(table.documentId),
  statusIdx: index('document_proposals_status_idx').on(table.status),
  expiresAtIdx: index('document_proposals_expires_at_idx').on(table.expiresAt),
}));

// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

export type DocumentProposal = typeof documentProposals.$inferSelect;
export type NewDocumentProposal = typeof documentProposals.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertDocumentProposalSchema = createInsertSchema(documentProposals);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectDocumentProposalSchema = createSelectSchema(documentProposals);
