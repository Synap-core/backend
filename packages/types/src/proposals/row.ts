/**
 * The proposal row on the wire (`proposals` table) — declared HERE, once.
 *
 * `@synap/database` (`schema/proposals.ts`) imports and re-exports these, so the
 * pod and every client read one declaration. `ProposalStatus` is the stored
 * enum: the list lives in `./attention.ts` (`PROPOSAL_STATUSES`, a LEAF the
 * phone imports), and the database proves its runtime `ProposalStatus` const is
 * exactly that list (`packages/database/src/wire-parity/proposals.ts`).
 * Pure types: nothing from the database package.
 */

import type { ProposalStatusValue } from "./attention.js";

/** Every status a proposal row can carry, as stored. */
export type ProposalStatus = ProposalStatusValue;

/**
 * One entry in a proposal's `revision_history` — a before/after snapshot of a
 * `reviseProposal` edit. `before` holds only the fields the patch changed, with
 * their prior values; `patch` is the applied change. `by` is the actor id.
 */
export interface ProposalRevision {
  at: string;
  by: string | null;
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
}

/** Proposal row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface Proposal {
  id: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
  status: ProposalStatus;
  createdBy: string | null;
  proposedByUserId: string | null;
  threadId: string | null;
  commandRunId: string | null;
  sourceMessageId: string | null;
  agentUserId: string | null;
  correlationId: string | null;
  requestedEventId: string | null;
  sessionId: string | null;
  stepRunId: string | null;
  nodeId: string | null;
  expiresAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  externalDispatchedAt: Date | null;
  dedupHash: string | null;
  rejectionReason: string | null;
  reasonCode: string | null;
  /** The app's `public_id` whose key filed this proposal, or null. */
  appId: string | null;
  comments: unknown;
  revisionHistory: ProposalRevision[];
  createdAt: Date;
  updatedAt: Date;
}
export type NewProposal = Partial<
  Omit<Proposal, "id" | "createdAt" | "updatedAt">
> & {
  workspaceId?: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
};
