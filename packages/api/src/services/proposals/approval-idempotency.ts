/**
 * Per-op link idempotency for a composite proposal APPROVAL.
 *
 * The composite approval branch materializes a graph with no idempotency of its
 * own, so a retried or double-clicked approval — and an `import.apply` routed
 * through that door (intake decision D7) — created the graph a second time.
 * Keyed by the PROPOSAL (client-stable: the same proposal is the same graph), a
 * retry LINKS the rows the first attempt created instead.
 *
 * `${userId}:${proposalId}` with provider `import` is the namespace the direct
 * `import.apply` used before D7 WHEN THE CLIENT SENT NO `idempotencyKey` (its
 * default key was the analyze proposal id) — then a half-applied import retried
 * through the governed door links what already landed. When a client DID send
 * an `idempotencyKey`, the direct path keyed `${userId}:${idempotencyKey}`
 * instead, and a retry through this door does NOT see those keys: rows from
 * that half-applied attempt are created again. Deliberate: the governed door
 * is keyed by the proposal it approves, never by a client-supplied string.
 *
 * The live-entity lookup in `entity-link-idempotency.ts` is untouched: a key
 * whose entity was reverted (soft-deleted) is a miss, so revert → reopen →
 * approve re-creates rather than re-linking a deleted row.
 */

import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";

type IdempotencyDatabase = Parameters<typeof makeExternalLinkIdempotency>[0];

export function approvalIdempotencyNamespace(
  userId: string,
  proposalId: string
): string {
  return `${userId}:${proposalId}`;
}

export function approvalIdempotencyProvider(proposalType: string): string {
  return proposalType === "import.graph" ? "import" : "proposal";
}

export function approvalIdempotency(
  database: IdempotencyDatabase,
  args: { userId: string; proposal: { id: string; proposalType: string } }
) {
  return makeExternalLinkIdempotency(database, {
    namespace: approvalIdempotencyNamespace(args.userId, args.proposal.id),
    provider: approvalIdempotencyProvider(args.proposal.proposalType),
    userId: args.userId,
    // Approved rows carry this proposal as lineage: a retry's hit on one of
    // them is the approval's own creation (a crash before the stamp).
    sourceProposalId: args.proposal.id,
  });
}
