/**
 * Documents Schema
 * For collaborative document editing with AI
 */

import { pgTable, text, timestamp, integer, jsonb, boolean, index, uuid } from 'drizzle-orm/pg-core';

/**
 * Documents table
 * Stores metadata about uploaded documents
 */
export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  
  // Document metadata
  title: text('title').notNull(),
  type: text('type').notNull(), // 'text' | 'markdown' | 'code' | 'pdf' | 'docx'
  language: text('language'), // For code files: 'typescript', 'python', etc.
  
  // Storage
  storageUrl: text('storage_url').notNull(), // MinIO/R2 URL
  storageKey: text('storage_key').notNull(), // Storage path
  size: integer('size').notNull(), // Bytes
  mimeType: text('mime_type'),
  
  // Versioning
  currentVersion: integer('current_version').notNull().default(1),
  
  // Relationships
  projectId: text('project_id'), // Optional project association
  
  // Metadata
  metadata: jsonb('metadata'), // Custom metadata
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  userIdIdx: index('documents_user_id_idx').on(table.userId),
  projectIdIdx: index('documents_project_id_idx').on(table.projectId),
  typeIdx: index('documents_type_idx').on(table.type),
}));

/**
 * Document versions table
 * Stores each version of the document for history
 */
export const documentVersions = pgTable('document_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  
  // Version info
  version: integer('version').notNull(),
  content: text('content').notNull(), // Full content at this version
  
  // Change tracking
  delta: jsonb('delta'), // Operational Transform operations
  author: text('author').notNull(), // 'user' | 'ai'
  authorId: text('author_id').notNull(),
  message: text('message'), // Commit message
  
  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  documentIdIdx: index('document_versions_document_id_idx').on(table.documentId),
  versionIdx: index('document_versions_version_idx').on(table.documentId, table.version),
}));

/**
 * Document sessions table
 * Tracks active editing sessions with AI collaboration
 */
export const documentSessions = pgTable('document_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  
  // Chat integration
  chatThreadId: uuid('chat_thread_id').notNull(), // Dedicated chat for this document
  
  // Session state
  isActive: boolean('is_active').notNull().default(true),
  activeCollaborators: jsonb('active_collaborators'), // Array of {type, id, cursor}
  
  // Timestamps
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (table) => ({
  documentIdIdx: index('document_sessions_document_id_idx').on(table.documentId),
  userIdIdx: index('document_sessions_user_id_idx').on(table.userId),
  activeIdx: index('document_sessions_active_idx').on(table.isActive),
}));

// Type exports
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

// Documents
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertDocumentSchema = createInsertSchema(documents);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectDocumentSchema = createSelectSchema(documents);

// Versions
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertDocumentVersionSchema = createInsertSchema(documentVersions);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectDocumentVersionSchema = createSelectSchema(documentVersions);

// Sessions
export type DocumentSession = typeof documentSessions.$inferSelect;
export type NewDocumentSession = typeof documentSessions.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertDocumentSessionSchema = createInsertSchema(documentSessions);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectDocumentSessionSchema = createSelectSchema(documentSessions);
