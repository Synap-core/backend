/**
 * Document Types
 * Re-exports from database schema for frontend usage
 */

// Re-export types from database schema (single source of truth)
export type {
  Document,
  NewDocument,
  DocumentVersion,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
  DocumentProposal,
  NewDocumentProposal,
} from '@synap/database/schema';

// Re-export Zod schemas for runtime validation
export {
  insertDocumentSchema,
  selectDocumentSchema,
  insertDocumentVersionSchema,
  selectDocumentVersionSchema,
  insertDocumentSessionSchema,
  selectDocumentSessionSchema,
  insertDocumentProposalSchema,
  selectDocumentProposalSchema,
} from '@synap/database/schema';
