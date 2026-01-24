/**
 * Universal Proposal Types
 *
 * Defines the contract for all data mutations in the system.
 */

// Re-export database types for proposals
export type {
  Proposal,
  NewProposal,
} from "../../../database/src/schema/index.js";

export {
  insertProposalSchema,
  selectProposalSchema,
} from "../../../database/src/schema/index.js";

/**
 * Universal Update Request
 *
 * The standard envelope for all change requests in the system.
 * This object is stored in the `proposals` table and passed in events.
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

  /** What kind of change? */
  changeType: "create" | "update" | "delete";

  /**
   * lightweight Metadata Changes
   * (e.g. title rename, status change)
   */
  data?: Record<string, any>;

  /**
   * Heavy Content Reference (S3/MinIO)
   * Used for Documents, Whiteboards, etc.
   */
  contentRef?: {
    storageKey: string;
    mimeType: string;
    size: number;
    // Optional hash for integrity
    checksum?: string;
  };

  /** AI Reasoning / Context */
  reasoning?: string;
}
