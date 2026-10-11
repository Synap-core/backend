/**
 * A reviewer's NOTE on a decided proposal — `proposals.comments` (jsonb array).
 *
 * A rejection's words live in `rejectionReason`; an APPROVAL had nowhere to
 * go: `proposals.approve` accepted `comment` and dropped it. The approve door
 * (`applyProposalApproval`, the ONE door single and batch approve share) now
 * appends one entry here, and every read of the row carries it — the proposal
 * page, and the agent through `synap_get_proposal`.
 *
 * PURE: the pod writes the shape, surfaces read it through
 * {@link readProposalReviewComments} — never by indexing the raw jsonb.
 */

export const PROPOSAL_REVIEW_COMMENT_KINDS = ["approval"] as const;
export type ProposalReviewCommentKind =
  (typeof PROPOSAL_REVIEW_COMMENT_KINDS)[number];

export interface ProposalReviewComment {
  kind: ProposalReviewCommentKind;
  /** What the reviewer wrote — trimmed, never empty. */
  text: string;
  /** The reviewer's user id. */
  by: string;
  /** ISO-8601. */
  at: string;
}

/** The entry the approve door appends — `null` when there is nothing to say. */
export function buildApprovalComment(
  text: string | null | undefined,
  by: string,
  at: Date = new Date()
): ProposalReviewComment | null {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return null;
  return { kind: "approval", text: trimmed, by, at: at.toISOString() };
}

/** Read the untyped column, oldest first; malformed entries are skipped. */
export function readProposalReviewComments(
  raw: unknown
): ProposalReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposalReviewComment[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (
      !(PROPOSAL_REVIEW_COMMENT_KINDS as readonly unknown[]).includes(r.kind)
    ) {
      continue;
    }
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    if (typeof r.by !== "string" || typeof r.at !== "string") continue;
    out.push({
      kind: r.kind as ProposalReviewCommentKind,
      text: r.text,
      by: r.by,
      at: r.at,
    });
  }
  return out;
}
