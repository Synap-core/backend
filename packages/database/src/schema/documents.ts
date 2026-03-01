/**
 * Documents Schema
 * For collaborative document editing with AI
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Documents table
 * Stores metadata about uploaded documents
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Context
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(), // Every document belongs to a workspace
    // Projects: Use relations table (if document is linked to entity) or remove projectIds

    // Document metadata
    title: text("title").notNull(),
    type: text("type").notNull(), // 'text' | 'markdown' | 'code' | 'pdf' | 'docx'
    language: text("language"), // For code files: 'typescript', 'python', etc.

    // Storage
    // All documents use MinIO storage (unified approach)
    // Current content is in storage, versions are snapshots in document_versions
    storageUrl: text("storage_url"), // MinIO/R2 URL
    storageKey: text("storage_key"), // Storage path
    size: integer("size").notNull().default(0), // Bytes (default 0 for whiteboards)
    mimeType: text("mime_type"),

    // Versioning
    currentVersion: integer("current_version").notNull().default(1),
    lastSavedVersion: integer("last_saved_version").notNull().default(0), // Last immutable snapshot

    // Working State (Yjs Persistence)
    // Stores the periodic binary dump of the Yjs doc for the *current working version*
    workingState: text("working_state"),
    workingStateUpdatedAt: timestamp("working_state_updated_at", {
      withTimezone: true,
    }),

    // Metadata
    metadata: jsonb("metadata"), // Custom metadata

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("documents_user_id_idx").on(table.userId),
    typeIdx: index("documents_type_idx").on(table.type),
  })
);

/**
 * Document versions table
 * Stores each version of the document for history
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    // Version info
    version: integer("version").notNull(),
    content: text("content").notNull(), // Full content at this version (snapshot)

    // Author tracking
    author: text("author").notNull(), // 'user' | 'system'
    authorId: text("author_id").notNull(), // User ID who created this version
    message: text("message"), // Optional commit message (for UI display in version history)

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    documentIdIdx: index("document_versions_document_id_idx").on(
      table.documentId
    ),
    versionIdx: index("document_versions_version_idx").on(
      table.documentId,
      table.version
    ),
  })
);

/**
 * Document sessions table
 * Tracks active editing sessions with AI collaboration
 */
export const documentSessions = pgTable(
  "document_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    // Chat integration
    channelId: uuid("channel_id").notNull(), // Dedicated channel for this document

    // Session state
    isActive: boolean("is_active").notNull().default(true),
    activeCollaborators: jsonb("active_collaborators"), // Array of {type, id, cursor}

    // Timestamps
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    documentIdIdx: index("document_sessions_document_id_idx").on(
      table.documentId
    ),
    userIdIdx: index("document_sessions_user_id_idx").on(table.userId),
    activeIdx: index("document_sessions_active_idx").on(table.isActive),
  })
);

// Type exports
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

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
