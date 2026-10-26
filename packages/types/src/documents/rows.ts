/**
 * Document rows on the wire — `documents`, `document_versions`,
 * `document_sessions` as the pod reads and inserts them.
 *
 * The pod's types are inferred from its drizzle tables; this package cannot see
 * those tables, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/documents.ts`): a column added
 * on one side only fails the database build.
 */

/** Who created a row (`created_by_kind`, the shared provenance vocabulary). */
export type ProvenanceKind = "human" | "ai_agent" | "system";

export interface Document {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  type: string;
  language: string | null;
  storageUrl: string | null;
  storageKey: string | null;
  size: number;
  mimeType: string | null;
  currentVersion: number;
  lastSavedVersion: number;
  workingState: string | null;
  workingStateUpdatedAt: Date | null;
  contentRevision: number;
  workingStateRevision: number | null;
  metadata: unknown;
  createdByKind: ProvenanceKind | null;
  createdByUserId: string | null;
  agentUserId: string | null;
  sourceProposalId: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface NewDocumentVersion {
  id?: string;
  documentId: string;
  version: number;
  content: string;
  storageUrl?: string | null;
  storageKey?: string | null;
  size?: number;
  mimeType?: string | null;
  author: "system" | "user" | "ai";
  authorId: string;
  message?: string | null;
  checksum?: string | null;
  createdAt?: Date;
}

export interface DocumentSession {
  id: string;
  documentId: string;
  userId: string;
  channelId: string;
  isActive: boolean;
  activeCollaborators: unknown;
  startedAt: Date;
  endedAt: Date | null;
}

export interface NewDocumentSession {
  id?: string;
  documentId: string;
  userId: string;
  channelId: string;
  isActive?: boolean;
  activeCollaborators?: unknown;
  startedAt?: Date;
  endedAt?: Date | null;
}
