/**
 * REFUSAL GUARD — a composite proposal may only be shown to a reviewer if the
 * review pipeline can render EVERY operation it carries.
 *
 * `CompositeProposalOperation` has five arms (`create_entity`,
 * `create_relation`, `create_skill`, `create_automation`, `create_rule`) while
 * `buildProposalGraph` renders exactly two, and `ProposalReviewGraph` has no
 * room for the other three. Without this guard a composite carrying a
 * `create_skill` / `create_automation` / `create_rule` op would render those
 * members INVISIBLY and — because `applyGraphDispositions` keeps every op it
 * does not recognise — apply them UNDENIABLY. A risky member hidden inside a
 * benign batch, arrived at by OMISSION rather than by averaging. Those three
 * ops are BEHAVIOUR: once approved they persist and act on their own, unlike
 * inert entity/relation data.
 *
 * The product decision is REFUSE, not flag: a proposal we cannot fully render
 * is a proposal we cannot honestly ask someone to consent to. Refusing is safe
 * and cheap to reverse; the day someone extends the renderer, the guard stops
 * firing on its own.
 *
 * DERIVED, NOT LISTED. There is deliberately no "renderable op kinds" constant
 * here. The renderer MARKS the index of every op it actually emitted, and this
 * guard compares ops SEEN against ops RENDERED. A hand-maintained second list
 * would BE the defect this guard exists to catch, one level up: it would drift
 * away from the renderer exactly the way `ProposalReviewGraph` drifted away
 * from `CompositeProposalOperation`.
 *
 * LATENT BY CONSTRUCTION: no producer emits the three unrendered ops today
 * (`services/import-orchestrator.ts` states outright that Rule Loop ops are
 * never produced by the import path), and every composite proposal on the live
 * pod is `create_entity` + `create_relation` only. This is a guard-rail written
 * while the road is still empty — it must be, and is, a no-op for all existing
 * traffic.
 */

import { TRPCError } from "@trpc/server";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

/**
 * Throw unless every operation was rendered.
 *
 * @param operations       the composite's ops, in their original order.
 * @param renderedIndexes  indexes the renderer emitted a review item for —
 *                         populated BY the render passes themselves, so this
 *                         set is derived from the rendering code rather than
 *                         from a parallel declaration of what is renderable.
 */
export function assertEveryOperationRendered(
  operations: CompositeProposalOperation[],
  renderedIndexes: ReadonlySet<number>
): void {
  const unrendered = operations
    .map((op, index) => ({ op, index }))
    .filter(({ index }) => !renderedIndexes.has(index));
  if (unrendered.length === 0) return;

  const kinds = [...new Set(unrendered.map(({ op }) => op.op))];
  const where = unrendered
    .map(({ op, index }) => `${op.op} (operation #${index})`)
    .join(", ");

  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `This proposal contains ${unrendered.length} operation(s) the review ` +
      `pipeline cannot render — ${where}. Refusing to build a review graph: a ` +
      `proposal that cannot be fully rendered cannot be honestly consented to, ` +
      `and an unrendered operation would still be applied on approval. ` +
      `To make ${kinds.join("/")} reviewable, extend buildProposalGraph ` +
      `(packages/api/src/routers/proposals/display.ts) to emit a review item ` +
      `for them AND widen the ProposalReviewGraph contract ` +
      `(synap-app/packages/core/proposal-types/src/types.ts) to carry it; this ` +
      `guard then stops firing on its own.`,
  });
}
