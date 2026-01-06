/**
 * Document Types
 * 
 * Re-exports document types from database schema (single source of truth).
 * 
 * @see {@link @synap/database/schema}
 */

// Direct re-exports from database
export type { 
  Document,
  NewDocument,
  DocumentVersion,
  NewDocumentVersion,
  DocumentSession,
  NewDocumentSession,
} from '@synap/database/schema';

// Derived/helper types for API operations
import type { Document } from '@synap/database/schema';

export type UpdateDocument = Partial<Omit<Document, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;
