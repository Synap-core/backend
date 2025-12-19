/**
 * Document Types
 * 
 * Types for document storage and versioning.
 */

/**
 * Document - stores file content with versioning
 */
export interface Document {
  id: string;
  userId: string;
  
  // Document metadata
  title: string;
  type: 'text' | 'markdown' | 'code' | 'pdf' | 'docx';
  language?: string; // For code files
  
  // Storage
  storageUrl: string; // MinIO/R2 URL
  storageKey: string; // Storage path
  size: number; // Bytes
  mimeType?: string;
  
  // Versioning
  currentVersion: number;
  
  // Relationships
  projectId?: string;
  
  // Metadata
  metadata?: Record<string, unknown>;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

/**
 * Document version - stores historical versions
 */
export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  content: string; // Full content at this version
  delta?: unknown; // Operational Transform operations
  author: '​user' | 'ai';
  authorId: string;
  message?: string; // Commit message
  createdAt: Date;
}

/**
 * Document session - for real-time collaboration
 */
export interface DocumentSession {
  id: string;
  documentId: string;
  userId: string;
  chatThreadId: string; // Dedicated chat for this document
  isActive: boolean;
  activeCollaborators?: Array<{
    type: 'user' | 'ai';
    id: string;
    cursor?: unknown;
  }>;
  startedAt: Date;
  endedAt?: Date;
}

/**
 * New document (for creation)
 */
export type NewDocument = Omit<Document, 'id' | 'currentVersion' | 'createdAt' | 'updatedAt'>;

/**
 * Document update (for updates)
 */
export type UpdateDocument = Partial<Omit<Document, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>;
