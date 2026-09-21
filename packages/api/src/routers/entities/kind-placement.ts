/**
 * Reconciling the KIND an entity carries with the WORKSPACE it lands in.
 *
 * THE DEFECT THIS EXISTS FOR, measured live 2026-09-21. `entities/create.ts`
 * resolves the profile with `governanceWorkspaceId`
 * (`targetWorkspaceId ?? ctx.workspaceId ?? null`) but resolves the row's HOME
 * separately, through `resolveWorkspacePlacement`. When those disagree and the
 * slug has a TWIN, the row is stored in workspace W carrying a profile that is
 * not visible under W's own lens.
 *
 * Observed on this pod: two `finding` profiles, both `scope=workspace`
 * (Research, created 2026-07-22; Builder, created 2026-09-20). At pod altitude
 * `ProfileRepository.getBySlug` ties them on priority and breaks the tie on
 * `createdAt ASC`, returning Research — while placement put the row in
 * Builder. Every property the Builder profile models came back `unmodeled`
 * and the row was written anyway.
 *
 * WHY A SECOND PASS RATHER THAN A REORDER: placement CONSUMES the profile (it
 * reads `entityScope` and the kind slug), so the dependency is circular. The
 * kind cannot be resolved in the placement workspace before the placement
 * workspace is known. So the caller places, re-resolves the kind there, and
 * asks this function what to do.
 */

/** Just enough of a profile row to decide. */
export interface PlacementCandidateProfile {
  id: string;
  entityScope: string | null | undefined;
}

export type KindPlacementDecision =
  /** The kind resolved in the placement workspace is the same one — nothing to do. */
  | { action: "keep" }
  /**
   * A DIFFERENT profile is the valid one where this row lands; adopt it.
   * `recomputePlacement` is true only when the adopted profile files
   * differently (its `entityScope` differs), which is the only case where the
   * home it implies can change.
   */
  | { action: "adopt"; recomputePlacement: boolean };

/** `null`/`undefined` entityScope reads as "workspace" — the column's default. */
function scopeOf(p: PlacementCandidateProfile): string {
  return p.entityScope === "pod" ? "pod" : "workspace";
}

/**
 * @param initial      the profile the ambient lens resolved (pass 1)
 * @param inPlacement  the profile the SAME slug resolves to in the workspace
 *                     placement chose, or null when the slug resolves to
 *                     nothing there
 */
export function reconcileKindWithPlacement(input: {
  initial: PlacementCandidateProfile;
  inPlacement: PlacementCandidateProfile | null;
}): KindPlacementDecision {
  const { initial, inPlacement } = input;

  // The slug resolves to nothing under the placement lens. KEEP the profile we
  // already have rather than failing: a pod-scoped kind placed into a
  // workspace that cannot see it is the normal case for a `scope=pod` profile,
  // and refusing here would break every pod-kind write. The twin problem only
  // arises when the placement lens resolves the slug to a DIFFERENT row.
  if (!inPlacement) return { action: "keep" };

  if (inPlacement.id === initial.id) return { action: "keep" };

  return {
    action: "adopt",
    // Only a scope change can move the home. Two twins with the same
    // entityScope file identically, so re-running placement would return the
    // same answer and cost a query for nothing.
    recomputePlacement: scopeOf(inPlacement) !== scopeOf(initial),
  };
}
