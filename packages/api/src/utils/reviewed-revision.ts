import { TRPCError } from "@trpc/server";
import type { ProposalRevision } from "@synap/database";

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
