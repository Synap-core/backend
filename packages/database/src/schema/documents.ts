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
import type { ProvenanceKind } from "./provenance.js";

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
    // Nullable for pod-wide documents (workspace is optional).
    workspaceId: uuid("workspace_id"),
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

    // Provenance (Wave B3) — who/what authored this row. FKs + indexes in
    // migration 0107.
    createdByKind: text("created_by_kind").$type<ProvenanceKind>(),
    createdByUserId: text("created_by_user_id"),
    agentUserId: text("agent_user_id"),
    sourceProposalId: uuid("source_proposal_id"),
    correlationId: uuid("correlation_id"),

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
 * Who authored a document version.
 *
 * THREE values, not two. `user` is a human's own save; `system` is the pod
 * writing on nobody's behalf (Yjs autosave, session-close snapshot); `ai` is an
 * agent's draft that a human then accepted. The third value is what makes the
 * accepted-AI-edit checkpoint honest: without it an agent's text lands stamped
 * as the reviewing human's own writing.
 *
 * The literal set is `ai`, not `agent`, because the product's ONE declared
 * union for this field already reads `"user" | "ai" | "system"`
 * (`synap-app/packages/core/markdown-engine/.../types/advanced-editor.ts`) and
 * its only discriminating reader tests `version.author === 'ai'`. A second
 * literal for the same concept is the drift this codebase keeps paying for.
 */
export const DOCUMENT_VERSION_AUTHORS = ["user", "system", "ai"] as const;
export type DocumentVersionAuthor = (typeof DOCUMENT_VERSION_AUTHORS)[number];

/**
 * Document versions table
 * Stores each immutable version of the document for history.
 *
 * Canonical content for new versions lives in storageKey/storageUrl, mirroring
 * documents.storageKey for the current version. `content` remains as a
 * backwards-compatible legacy/preview field for rows created before stored
 * version snapshots existed.
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
    content: text("content").notNull(), // Legacy/preview content; prefer storageKey when present.

    // Immutable version storage
    storageUrl: text("storage_url"),
    storageKey: text("storage_key"),
    size: integer("size").notNull().default(0),
    mimeType: text("mime_type"),
    checksum: text("checksum"),

    // Author tracking. The declared set is DOCUMENT_VERSION_AUTHORS below —
    // 'ai' exists because an accepted AI edit is drafted by an agent and
    // accepted by a human, and a version that stamps only the accepting human
    // erases the agent from the provenance rail.
    author: text("author").notNull().$type<DocumentVersionAuthor>(),
    authorId: text("author_id").notNull(), // Agent or user id that AUTHORED this version
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
    storageKeyIdx: index("document_versions_storage_key_idx").on(
      table.storageKey
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
