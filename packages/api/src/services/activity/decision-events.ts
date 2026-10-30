/**
 * DECISION EVENTS — a proposal as the two history events it is: asked (pending,
 * by its author) and answered (decided by a PERSON, with the reviewer's note).
 * ONE projection for the track history and the session timeline; each caller
 * says what refs (and extra fields, e.g. a stage) its events carry.
 */

import { readProposalReviewComments } from "@synap-core/types/proposals";

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
      actorId: p.reviewedBy,
      isAgent: false,
    });
  }
  return out;
}
