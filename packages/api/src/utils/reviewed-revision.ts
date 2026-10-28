import { TRPCError } from "@trpc/server";
import type { ProposalRevision } from "@synap/database";
import { PAGE_ONLY_REVISION_REASON_CODE as REVIEWED_REVISION_REQUIRED } from "@synap-core/types/proposals";

/**
 * Slice 5 — bind an approval to the version the reviewer actually saw
 * (PlanetScale deploy-request pattern). `revisionHistory` grows by one entry on
 * EVERY `mergeProposalRevision`, so its length is a monotonic version signal for
 * a pending proposal. If the reviewer's client passes the length it last saw
 * (`expectedRevision`) and a concurrent revise (AI self-revise or another human
 * edit) has since appended to it, throw CONFLICT — the reviewer would otherwise
 * approve something they never saw and must reload.
 *
 * Fully backward-compatible: `expectedRevision === undefined` is a no-op, so
 * every existing caller (which sends nothing) behaves exactly as before. Callers
 * MUST invoke this BEFORE any mutation so a stale approve never materializes.
 *
 * Kept in its own leaf module (type-only + `@trpc/server` imports) so it stays
 * executably unit-testable without pulling the whole proposals router graph.
 */
export function assertReviewedRevision(
  expectedRevision: number | undefined,
  revisionHistory: ProposalRevision[] | null | undefined
): void {
  if (expectedRevision === undefined) return;
  const actual = revisionHistory?.length ?? 0;
  if (expectedRevision !== actual) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This proposal changed since you reviewed it — reload to see the current version.",
    });
  }
}

/**
 * A REVISED proposal is approved only against the revision the approver saw
 * (audit F1, 2026-10-28). `assertReviewedRevision` is a no-op when the call
 * names no revision, and most inline Approve buttons name none, so a revise
 * landing between render and tap (an agent amending its request, or the IS)
 * was approved unseen. Now, while the proposal is pending, a call that names
 * no revision is refused when the LATEST revision was filed by anyone but the
 * approving person acting for themself (an agent's revision is recorded with
 * `actingAgentUserId`, its `by` being the agent's human). The approver's own
 * edit (the page's "Save & Approve", which revises then approves) stays
 * exempt: they wrote what they approve.
 *
 * Refused with CONFLICT and the reason code clients already route to the
 * proposal's page (`REVIEWED_REVISION_REQUIRED`). Call it only when the
 * approve call named no revision.
 */
export function assertRevisedProposalBound(args: {
  status: string;
  revisionHistory: ProposalRevision[] | null | undefined;
  approverUserId: string;
}): void {
  if (args.status !== "pending") return;
  const history = args.revisionHistory ?? [];
  const latest = history[history.length - 1] as
    (ProposalRevision & { actingAgentUserId?: string | null }) | undefined;
  if (!latest) return;
  if (latest.by === args.approverUserId && !latest.actingAgentUserId) return;
  throw new TRPCError({
    code: "CONFLICT",
    message:
      "Open it to approve: it was changed after it was filed, and only its page shows the version you approve.",
    cause: { reasonCode: REVIEWED_REVISION_REQUIRED },
  });
}
