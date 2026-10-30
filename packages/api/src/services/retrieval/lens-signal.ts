/**
 * Lens signal — the ONE definition of "this row matches your focus", kept PURE
 * (same discipline as composite-rerank / horizon-rerank). Every ranker reads it:
 *   - baseline (`compositeRerank`): a bounded nudge (`LENS_FRACTION`);
 *   - Horizon (`horizonScore`): its `L` term;
 *   - session-start recall (`selectRecalled`): its small lens bonus.
 *
 * A focus BOOSTS, it never filters (decision 756c740f: workspace focus "never
 * hides pod-scoped knowledge"). An explicit `workspaceId` / `projectId` the
 * caller passes stays a filter upstream, in the recall passes; this signal only
 * re-orders rows recall already returned.
 *
 * The checks run in a fixed order, and the first match decides the score:
 *   1. the row's workspace is the focus workspace (exact, indexed column);
 *   2. a pod-wide row's home workspace is the focus workspace (only where the
 *      create door already stamped one — never backfilled: a home grants that
 *      space's members read access, `home-space-visibility.ts`);
 *   3. the row belongs to the focus project (`belongs_to_project`).
 * The scores fall in that order because each check says less: a home is a
 * weaker claim than a row filed in the space, and project membership is the
 * broadest (896 of 1,889 knowledge rows belong to the Synap project alone).
 */

/** The focus a ranker weighs. `projectIds` is the focus project's entity-id
 *  set (the project + its `belongs_to_project` members), resolved once. */
export interface LensFocus {
  workspaceId?: string | null;
  projectIds?: ReadonlySet<string> | null;
}

export interface LensRow {
  id: string;
  workspaceId?: string | null;
  homeWorkspaceId?: string | null;
}

/** Affinity per check, in [0, 1]. Order matters: workspace > home > project. */
export const LENS_AFFINITY = {
  workspace: 1,
  homeWorkspace: 0.75,
  project: 0.5,
} as const;

/** How strongly `row` matches `focus`, in [0, 1]. 0 when there is no focus. */
export function lensAffinity(
  row: LensRow,
  focus: LensFocus | null | undefined
): number {
  if (!focus) return 0;
  const ws = focus.workspaceId;
  if (ws) {
    if (row.workspaceId === ws) return LENS_AFFINITY.workspace;
    if (!row.workspaceId && row.homeWorkspaceId === ws)
      return LENS_AFFINITY.homeWorkspace;
  }
  if (focus.projectIds?.has(row.id)) return LENS_AFFINITY.project;
  return 0;
}
