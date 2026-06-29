/**
 * ScopeFilter — the ONE canonical scope contract every list/fetch door speaks.
 *
 * The rule, in one sentence: a read starts from the USER FLOOR (everything the
 * user can access — all their workspaces + pod-wide globals + project/exposure
 * membership) and each lens that is PRESENT only NARROWS it. No lens = the floor.
 *
 * Lenses are multi-valued and composable (the "personalizable fetch"):
 *   - `workspaceId`: `undefined` = no narrow (floor) · `null` = pod-personal/
 *      globals only · `"<id>"` = that workspace · `string[]` = that SET (union)
 *   - `projectId`:   `undefined`/`null` = no narrow · `"<id>"` or `string[]` =
 *      that project/anchor (or set) — the entity + everything exposed to it
 *
 * This schema goes in the procedure INPUT (not a header) so the lens lands in the
 * React Query cache key and reads never bleed across scopes. The active-workspace
 * header (`ctx.workspaceId`) is only a DEFAULT lens: an explicit input lens (incl.
 * `null` to clear to globals, or `[]`/`undefined` to widen to the floor) overrides
 * it. Feed the resolved lenses to `accessScopeWhere` (DATA tables) or
 * `AccessContext.withLens/withProjectLens` (scopedDb tables).
 *
 * See team/platform/project-centric-scope.mdx and the access layer (src/access/).
 */

import { z } from "zod";
import type { Lens } from "../access/context.js";

/** A single lens dimension as wire input: id, set of ids, explicit null, or absent. */
const LensValue = z
  .union([z.string(), z.array(z.string()), z.null()])
  .optional();

/**
 * The canonical scope input. Spread into any list/fetch procedure's `z.object`
 * so every door declares scope IDENTICALLY:
 *
 *   .input(z.object({ ...ScopeFilterShape, limit: z.number()... }))
 */
export const ScopeFilterShape = {
  /**
   * Workspace lens. Omit for the user floor (all your workspaces + globals);
   * pass one or many ids to narrow; pass `null` for pod-personal/globals only.
   */
  workspaceId: LensValue,
  /**
   * Project / exposure-anchor lens. Omit for no project narrowing; pass one or
   * many project ids to narrow to that project's data (across workspaces).
   */
  projectId: LensValue,
} as const;

export const ScopeFilterSchema = z.object(ScopeFilterShape);

export type ScopeFilterInput = z.infer<typeof ScopeFilterSchema>;

/** The resolved lenses, ready to hand to accessScopeWhere / AccessContext. */
export interface ResolvedScope {
  workspaceLens: Lens;
  projectLens: Lens;
}

/**
 * Resolve a ScopeFilter input against the request context into the two lenses.
 *
 * Precedence for the workspace lens: an EXPLICIT input value always wins (incl.
 * `null` = globals, `[]`/an id = narrow). Only when `workspaceId` is entirely
 * ABSENT from the input do we fall back to the active-workspace header
 * (`ctx.workspaceId`) as a default lens — and if there is no header either, the
 * lens stays `undefined` = the user floor. The project lens has no header
 * default: absent = no narrow.
 */
export function resolveScope(
  ctx: { workspaceId?: string | null },
  input: ScopeFilterInput
): ResolvedScope {
  const workspaceLens: Lens =
    input.workspaceId !== undefined
      ? input.workspaceId
      : (ctx.workspaceId ?? undefined);
  const projectLens: Lens = input.projectId ?? undefined;
  return { workspaceLens, projectLens };
}
