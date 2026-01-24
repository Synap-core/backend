/**
 * Document Types
 * Re-exports from database schema for frontend usage
 */

// Re-export types from database schema (single source of truth)
export type {
  Document,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
} from "../../../database/src/schema/index.js";

// Re-export Zod schemas for runtime validation
export {
  insertDocumentVersionSchema,
  selectDocumentVersionSchema,
  insertDocumentSessionSchema,
  selectDocumentSessionSchema,
} from "../../../database/src/schema/index.js";
