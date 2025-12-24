/**
 * Views Schema - Extensible view system
 * 
 * Supports multiple view types:
 * - whiteboard (visual canvas with entities)
 * - timeline (chronological view)
 * - kanban (board view)
 * - table (spreadsheet view)
 * - mindmap (hierarchical view)
 */

import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { documents } from './documents.js';

export const views = pgTable('views', {
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Ownership
  workspaceId: uuid('workspace_id')
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), // Creator
  
  // View type (extensible)
  type: text('type').notNull(), 
  // 'whiteboard' | 'timeline' | 'kanban' | 'table' | 'mindmap' | 'graph'
  
  // Metadata
  name: text('name').notNull(),
  description: text('description'),
  
  // Content reference (stores actual view data as JSON)
  documentId: uuid('document_id')
    .references(() => documents.id, { onDelete: 'set null' }),
  
  // Quick-access metadata (for listings, thumbnails, search)
  metadata: jsonb('metadata').default('{}').notNull(),
  // {
  //   thumbnail: 'url-to-thumbnail.png',
  //   entityCount: 10,
  //   lastEditedBy: 'user-123',
  //   bounds: { width: 1920, height: 1080 },
  //   viewConfig: { /* type-specific config */ }
  // }
  
  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type View = typeof views.$inferSelect;
export type NewView = typeof views.$inferInsert;
