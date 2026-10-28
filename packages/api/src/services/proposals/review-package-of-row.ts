/**
 * A stored proposal row → its REVIEW PACKAGE (`reviewPackageOf`,
 * `@synap-core/types/proposals/review-package`, founder B-1).
 *
 * The classifier is the types leaf; this module only reads the three things a
 * row carries that the leaf takes as plain fields: the pod's proposal class
 * (`proposalClassFields`, the one door), the record kind a create makes (the
 * payload's `profileSlug`), and whether a person filed it (no agent). Every
 * server door that stamps or filters a package — `proposals.list`,
 * `proposals.groups` (through the cluster collapse), the needs-you union and
 * MCP `synap_list_proposals` — reads it through here.
 */

import {
  REVIEW_PACKAGES,
  reviewPackageOf,
  reviewPackageRank,
  type ReviewPackage,
} from "@synap-core/types/proposals/review-package";
import { capabilityRunVerbId, classifyProposal } from "./proposal-class.js";

export { REVIEW_PACKAGES, type ReviewPackage };

/** The proposal columns this reads. A stored row and a cluster input both fit. */
export interface ReviewPackageRow {
  proposalType: string;
  targetType: string;
  data: unknown;
  agentUserId?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The kind a create makes, off its payload — the request envelope keeps it at
 * `data.data.profileSlug`, a flat entity record at `data.profileSlug` (the same
 * unwrap `extractProposalName` does).
 */
function objectKindOf(data: unknown): string | null {
  const envelope = asRecord(data);
  const payload = asRecord(envelope?.data) ?? envelope;
  const slug = payload?.profileSlug;
  return typeof slug === "string" && slug ? slug : null;
}

export function reviewPackageOfRow(row: ReviewPackageRow): ReviewPackage {
  return reviewPackageOf({
    kind: "proposal-cluster",
    proposalType: row.proposalType,
    targetType: row.targetType,
    class: classifyProposal(
      row.proposalType,
      row.targetType,
      capabilityRunVerbId(row.data)
    ),
    objectKind: objectKindOf(row.data),
    data: row.data,
    filedByPerson: row.agentUserId === undefined ? null : !row.agentUserId,
  });
}

/**
 * The package of a GROUP of rows (a fingerprint cluster): the highest-stakes
 * member's, so a cluster is never filed below what one of its members asks.
 * Members share proposalType × targetType by construction; only their
 * payloads (a create's kind, a pack's writes) or authors can differ.
 */
export function reviewPackageOfRows(
  rows: readonly ReviewPackageRow[]
): ReviewPackage {
  let best: ReviewPackage | null = null;
  for (const row of rows) {
    const pkg = reviewPackageOfRow(row);
    if (best === null || reviewPackageRank(pkg) < reviewPackageRank(best))
      best = pkg;
  }
  return best ?? "data-changes";
}
