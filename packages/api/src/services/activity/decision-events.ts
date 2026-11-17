/**
 * DECISION EVENTS — a proposal as the two history events it is: asked (pending,
 * by its author) and answered (decided by a PERSON, with the reviewer's note).
 * ONE projection for the track history and the session timeline; each caller
 * says what refs (and extra fields, e.g. a stage) its events carry, and both
 * read their rows through `decisionRowsWhere`. The activity ledger's
 * `decision` source reads its answered rows through `answeredRowWhere`.
 *
 * One answer is not a person's: an agent's auto-applied receipt that failed
 * (`approval_failed`, no `reviewedBy`, see `createAutoApprovedProposal`). It
 * is answered by its agent, or by the pod when no agent is recorded.
 */

import {
  and,
  eq,
  inArray,
  isNotNull,
  or,
  proposals,
  type SQL,
} from "@synap/database";
import { readProposalReviewComments } from "@synap-core/types/proposals";

/** The statuses a proposal is ANSWERED in (pending is the asked side). */
export const DECISION_STATUSES = [
  "approved",
  "rejected",
  "reverted",
  "approval_failed",
] as const;

/**
 * An answered proposal a history shows: decided by a person (`reviewedBy`),
 * or an automatic receipt's failure, which has no reviewer. Without that last
 * arm the failure of an agent's receipt went silent once it stopped naming the
 * person. The caller narrows the status (`DECISION_STATUSES` or fewer). A
 * constant fragment: `and` / `or` / `.where()` only read it.
 */
export const answeredRowWhere: SQL = and(
  isNotNull(proposals.reviewedAt),
  or(isNotNull(proposals.reviewedBy), eq(proposals.status, "approval_failed"))
)!;

/**
 * The proposals a history reads as decision events: the pending ones (asked)
 * and the answered ones (`answeredRowWhere`).
 */
export const decisionRowsWhere: SQL = or(
  eq(proposals.status, "pending"),
  and(inArray(proposals.status, [...DECISION_STATUSES]), answeredRowWhere)
)!;

export interface DecisionRow {
  id: string;
  status: string;
  summary: string | null;
  createdAt: Date | string;
  reviewedAt: Date | string | null;
  authorId: string | null;
  agentUserId: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  comments: unknown;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export function decisionEvents<
  R extends DecisionRow,
  Refs extends object,
  Extra extends object = Record<never, never>,
>(rows: readonly R[], carry: (row: R) => { refs: Refs; extra?: Extra }) {
  const out: Array<{
    event: (
      | { kind: "decision_asked" }
      | {
          kind: "decision_answered";
          decision: string;
          note: string | null;
        }
    ) & { id: string; at: string; refs: Refs; title: string | null } & Extra;
    actorId: string | null;
    isAgent: boolean;
  }> = [];
  for (const p of rows) {
    const { refs, extra } = carry(p);
    const base = {
      refs,
      title: p.summary ?? null,
      ...(extra ?? ({} as Extra)),
    };
    if (p.status === "pending") {
      out.push({
        event: {
          id: `proposal:${p.id}:ask`,
          kind: "decision_asked",
          at: iso(p.createdAt),
          ...base,
        },
        actorId: p.authorId,
        isAgent: Boolean(p.agentUserId),
      });
      continue;
    }
    const approvalNote = readProposalReviewComments(p.comments)
      .filter((c) => c.kind === "approval")
      .at(-1)?.text;
    out.push({
      event: {
        id: `proposal:${p.id}:answer`,
        kind: "decision_answered",
        at: iso(p.reviewedAt!),
        ...base,
        decision: p.status,
        note:
          (p.status === "rejected" ? p.rejectionReason : approvalNote) ?? null,
      },
      // No reviewer: its agent, else the pod (`activityActorOf` → system).
      // Never the author column, which holds the person.
      actorId: p.reviewedBy ?? p.agentUserId,
      isAgent: !p.reviewedBy && Boolean(p.agentUserId),
    });
  }
  return out;
}
