/**
 * The kind an entity carries must be the one valid where the row LANDS.
 *
 * WHAT THIS COVERS: the reconciliation DECISION — the seam `entities/create.ts`
 * consults after placement resolves. Each fixture below is chosen because it
 * rules a candidate rule OUT; a row that every plausible rule agrees on is
 * decoration, not coverage.
 *
 * WHAT THIS DOES NOT COVER, measured and stated rather than implied:
 *  - That `ProfileResolutionService.resolveProfile` actually returns DIFFERENT
 *    rows for the same slug under two lenses. That is the premise, and it was
 *    verified against the LIVE pod on 2026-09-21, not here: profiles
 *    `bc633e0d` (Research, createdAt 2026-07-22) and `341ba972` (Builder,
 *    2026-09-20) both carry slug `finding`, both `scope=workspace`, and
 *    `getBySlug` breaks their priority tie on `createdAt ASC`.
 *  - The full `entities.create` path. There is no pglite harness driving that
 *    procedure, and building one was out of proportion here. So this proves
 *    the decision, NOT that create wires it correctly — that is covered only
 *    by the fact that the call site fails typecheck if the shape changes.
 *  - The oscillation refusal, which is control flow in `create.ts` (two
 *    placement passes disagreeing), not part of this pure function.
 */
import { describe, expect, it } from "vitest";
import { reconcileKindWithPlacement } from "./kind-placement.js";

const RESEARCH = { id: "bc633e0d", entityScope: "workspace" };
const BUILDER = { id: "341ba972", entityScope: "workspace" };
const BUILDER_POD = { id: "341ba972", entityScope: "pod" };

describe("reconcileKindWithPlacement", () => {
  it("THE LIVE CASE: a different twin in the placement workspace is ADOPTED", () => {
    // Ambient lens gave Research (older, wins the createdAt tie-break at pod
    // altitude); the row is landing in Builder, where the slug means Builder's
    // profile. The row must carry Builder's.
    expect(
      reconcileKindWithPlacement({ initial: RESEARCH, inPlacement: BUILDER })
    ).toEqual({ action: "adopt", recomputePlacement: false });
  });

  it("same profile under both lenses is a no-op", () => {
    expect(
      reconcileKindWithPlacement({ initial: BUILDER, inPlacement: BUILDER })
    ).toEqual({ action: "keep" });
  });

  it("DISCRIMINATING: adopting a twin with the SAME scope does NOT recompute placement", () => {
    // Rules out "always recompute after adopting". Two profiles with the same
    // entityScope file identically, so a second placement pass would return
    // the same answer and cost a query for nothing.
    const d = reconcileKindWithPlacement({
      initial: RESEARCH,
      inPlacement: BUILDER,
    });
    expect(d).toMatchObject({ action: "adopt" });
    expect(
      (d as { recomputePlacement: boolean }).recomputePlacement,
      "recomputed placement for a scope-identical twin — a wasted pass"
    ).toBe(false);
  });

  it("DISCRIMINATING: adopting a twin with a DIFFERENT scope DOES recompute", () => {
    // Rules out "never recompute". A pod-scoped twin files somewhere else, so
    // the home implied by the corrected kind can differ.
    expect(
      reconcileKindWithPlacement({
        initial: RESEARCH,
        inPlacement: BUILDER_POD,
      })
    ).toEqual({ action: "adopt", recomputePlacement: true });
  });

  it("DISCRIMINATING: an unresolvable slug in the placement workspace KEEPS the profile", () => {
    // Rules out "refuse whenever the placement lens disagrees". A `scope=pod`
    // kind placed into a workspace that cannot see it is the NORMAL case —
    // refusing here would break every pod-kind write. The twin problem only
    // exists when the lens resolves the slug to a DIFFERENT ROW.
    expect(
      reconcileKindWithPlacement({ initial: RESEARCH, inPlacement: null })
    ).toEqual({ action: "keep" });
  });

  it("treats a null/undefined entityScope as `workspace`, matching the column default", () => {
    // So an unset scope can never be mistaken for `pod` and trigger a needless
    // placement recompute.
    const d = reconcileKindWithPlacement({
      initial: { id: "a", entityScope: null },
      inPlacement: { id: "b", entityScope: undefined },
    });
    expect(d).toEqual({ action: "adopt", recomputePlacement: false });
  });
});
