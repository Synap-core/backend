/**
 * Document Types
 * Re-exports from database schema for frontend usage
 */

// Pure long-form-content heuristic — the single definition of "this is a
// document", shared by every writer surface (api capture/import + jobs worker).
export { shouldMaterializeAsDocument } from "./document-heuristic.js";

// Re-export types from database schema (single source of truth)
export type {
  Document,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
} from "@synap/database";

// NOTE: Zod schemas (insert/selectDocumentVersionSchema, insert/selectDocumentSessionSchema)
// intentionally NOT re-exported — they pull in postgres/drizzle which breaks
// browser/Electron builds. Backend consumers should import directly from
// @synap/database.
