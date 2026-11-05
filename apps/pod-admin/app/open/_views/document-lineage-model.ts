/**
 * A document's links to its proposals, in plain words (plan "proposal
 * failures you can resolve" §B3, 2 Nov 2026). Pure; `document-view.tsx`
 * only draws it.
 *
 * - "Created from a proposal · approved by Antoine, 2 Nov 2026" when the
 *   document carries `sourceProposalId`, linking to that proposal. Who
 *   decided comes from the proposal as `proposals.list` returned it (the
 *   approver the pod names, or "automatically" for an auto-applied write).
 *   A creating proposal the viewer cannot see still gets the line and the
 *   link, without a name: the proposal page then says what the viewer may
 *   know.
 * - "2 changes waiting" when proposals about this document are pending,
 *   each a door to its proposal.
 *
 * The rows come from `proposals.list({ subject: { kind: "document", id } })`,
 * which returns every proposal ABOUT the document: those targeting it plus
 * the one that created it.
 */

import { formatDate } from "../../../lib/format";
import { proposalHeading } from "../../proposal/[id]/proposal-heading";

/** The `proposals.list` fields this reads, structurally. */
export interface DocumentProposalLike {
  id: string;
  status: string;
  targetType?: string | null;
  targetName?: string | null;
  proposalType?: string | null;
  agentActorName?: string | null;
  review?: unknown;
  data?: unknown;
  request?: { data?: unknown } | null;
  approverName?: string | null;
  reviewedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface DocumentLineage {
  /** The proposal that created the document; null when none is recorded. */
  createdFrom: { href: string; line: string } | null;
  /** Pending proposals about the document, newest first as listed. */
  waiting: Array<{ id: string; href: string; label: string }>;
  /** "1 change waiting" / "3 changes waiting"; null when none. */
  waitingLabel: string | null;
}

const proposalHref = (id: string) => `/proposal/${encodeURIComponent(id)}`;

function decidedPart(p: DocumentProposalLike | undefined): string {
  if (!p) return "";
  const when = p.reviewedAt ?? p.updatedAt ?? null;
  const date = when ? formatDate(when) : null;
  const at = date && date !== "—" ? `, ${date}` : "";
  if (p.approverName) return ` · approved by ${p.approverName}${at}`;
  if (p.status === "auto_approved") return ` · approved automatically${at}`;
  if (p.status === "approved") return ` · approved${at}`;
  return "";
}

export function documentLineage(
  sourceProposalId: string | null | undefined,
  proposals: readonly DocumentProposalLike[]
): DocumentLineage {
  const createdFrom = sourceProposalId
    ? {
        href: proposalHref(sourceProposalId),
        line: `Created from a proposal${decidedPart(
          proposals.find((p) => p.id === sourceProposalId)
        )}`,
      }
    : null;
  const waiting = proposals
    .filter((p) => p.status === "pending" && p.id !== sourceProposalId)
    .map((p) => ({
      id: p.id,
      href: proposalHref(p.id),
      // What approving it will do, as the review page heads it.
      label: proposalHeading(p, p.request?.data ?? p.data).heading,
    }));
  const n = waiting.length;
  return {
    createdFrom,
    waiting,
    waitingLabel: n === 0 ? null : `${n} change${n === 1 ? "" : "s"} waiting`,
  };
}
