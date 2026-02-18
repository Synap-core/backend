/**
 * Universal Proposal Types
 *
 * Defines the contract for all data mutations in the system.
 */

import type { EventAction } from "../events/unified.js";

// Re-export database types for proposals
export type { Proposal, NewProposal } from "@synap/database";

export { insertProposalSchema, selectProposalSchema } from "@synap/database";

/**
 * Universal Update Request
 *
 * The standard envelope for all change requests in the system.
 * This object is stored in the `proposals` table (as part of StoredProposalData)
 * and passed in events. changeType aligns with EventAction for event-sourced flow.
 */
export interface UpdateRequest {
  /** Unique ID for this specific request */
  requestId: string;

  /** Who initiated the change? */
  source: "user" | "ai" | "system";
  sourceId: string;

  /** Context */
  workspaceId: string;

  /** Target Entity */
  targetType: "document" | "entity" | "whiteboard" | "view";
  targetId: string;

  /** What kind of change? (aligns with EventAction) */
  changeType: EventAction;

  /**
   * Lightweight metadata changes (e.g. title rename, status change).
   * For entities: create/update payload. For documents: not used when proposedContent is used.
   */
  data?: Record<string, unknown>;

  /**
   * Heavy Content Reference (S3/MinIO).
   * Used for Documents, Whiteboards, etc.
   */
  contentRef?: {
    storageKey: string;
    mimeType: string;
    size: number;
    checksum?: string;
  };

  /** AI Reasoning / Context */
  reasoning?: string;
}

/**
 * Request-shaped proposal data (event-sourced path).
 * Written by global-validator and entity proposals from chat.
 * Approve uses this to emit `*.validated`.
 */
export interface RequestShapedProposalData extends UpdateRequest {
  reasoning?: string;
  aiMetadata?: Record<string, unknown>;
}

/**
 * Document-content proposal data (direct content path).
 * Written by hub document edit, infinite-chat document edit, user_edit.
 * Approve uses proposedContent and applies to storage/versions.
 */
export interface DocumentContentProposalData {
  proposedContent: string;
  proposedBy?: string;
  changes?: unknown[];
  originalContent?: string | null;
  expiresAt?: string;
  range?: [number, number];
  originalSnippet?: string;
  replacementText?: string;
  messageId?: string;
  threadId?: string;
}

/**
 * Union of all shapes stored in proposals.data.
 * Use isRequestShapedProposalData() to narrow in approve flow.
 */
export type StoredProposalData =
  | RequestShapedProposalData
  | DocumentContentProposalData;

/**
 * Type guard: true when proposal.data is request-shaped (event flow).
 * Use for the branch that emits *.validated.
 */
export function isRequestShapedProposalData(
  data: StoredProposalData | null | undefined
): data is RequestShapedProposalData {
  if (data == null || typeof data !== "object") return false;
  const d = data as unknown as Record<string, unknown>;
  return (
    typeof d.targetType === "string" &&
    typeof d.changeType === "string" &&
    typeof d.requestId === "string"
  );
}

/**
 * Type guard: true when proposal.data has proposedContent (document content flow).
 * Use for the branch that applies content directly.
 */
export function isDocumentContentProposalData(
  data: StoredProposalData | null | undefined
): data is DocumentContentProposalData {
  if (data == null || typeof data !== "object") return false;
  return (
    typeof (data as DocumentContentProposalData).proposedContent === "string"
  );
}
