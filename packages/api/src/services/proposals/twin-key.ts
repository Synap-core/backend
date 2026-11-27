/**
 * "The same proposal twice": ONE key, read by every health number that counts
 * duplicate proposals: `diagnose({type: "proposal"})`'s duplicate clusters and
 * the agent scorecard's `duplicateRate`. Both call {@link findProposalTwins},
 * so the cluster list and the rate can never disagree about what a twin is.
 *
 * NOT the review fingerprint (`computeProposalFingerprint`, `fingerprint.ts`).
 * That one GROUPS for review: every run of one capability shares the
 * capability as its target, so seven deletes of seven different notes are one
 * review group. Counted as duplicates, they were a false alarm: diagnose
 * reported 7 clusters (one of 7) and the scorecard 44% duplicates for an agent
 * whose sampled writes were all different (finding 9ae52db7).
 *
 * The key is the write-time dedup key, reused, not restated:
 * `computeProposalDedupHash` (`@synap/database`). It covers the proposal type,
 * the target type, the target id (left out for a create, whose id is minted per
 * attempt) and the payload without its per-attempt plumbing, keys sorted. So
 * the same verb on two targets, or with two different arguments, is two
 * proposals; the same change filed twice is one, whatever its key order.
 *
 * An agent row stores that hash when it is filed (`proposals.dedup_hash`) and
 * keeps it after it leaves the queue, so a withdrawn proposal and its refile
 * still share it although the withdraw stamped `withdrawReason` into `data`.
 * A row without one (a person's, or one filed before the column) has it
 * computed from its stored payload.
 */
import { computeProposalDedupHash } from "@synap/database";
import {
  resolveTargetLabel,
  type ProposalFingerprintInput,
} from "./fingerprint.js";

/** The columns the twin key reads. */
export interface ProposalTwinInput extends ProposalFingerprintInput {
  workspaceId: string | null;
  /** `proposals.dedup_hash`: stored for agent rows, null for a person's. */
  dedupHash?: string | null;
}

/** One group of rows that are the same proposal (`count` is at least 2). */
export interface ProposalTwinGroup {
  /** The first member's target label (`resolveTargetLabel`). */
  targetLabel: string;
  count: number;
}

/** The key two proposals share exactly when they propose the same change. */
export function proposalTwinKey(row: ProposalTwinInput): string {
  if (row.dedupHash) return row.dedupHash;
  return computeProposalDedupHash({
    workspaceId: row.workspaceId,
    proposalType: row.proposalType,
    targetType: row.targetType,
    targetId: row.targetId,
    data: (row.data ?? {}) as Record<string, unknown>,
  });
}

/** The groups of two or more rows that are the same proposal, largest first. */
export function findProposalTwins(
  rows: readonly ProposalTwinInput[]
): ProposalTwinGroup[] {
  const groups = new Map<string, { first: ProposalTwinInput; count: number }>();
  for (const row of rows) {
    const key = proposalTwinKey(row);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { first: row, count: 1 });
  }
  return [...groups.values()]
    .filter((g) => g.count > 1)
    .map((g) => ({
      targetLabel: resolveTargetLabel(g.first),
      count: g.count,
    }))
    .sort((a, b) => b.count - a.count);
}
