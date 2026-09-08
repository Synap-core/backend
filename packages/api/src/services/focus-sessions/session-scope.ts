/**
 * The `focus_sessions` LENS APPLICATION — the one place a `ResolvedScope`
 * becomes SQL conditions on this table.
 *
 * `resolveScope` (utils/scope-filter.ts) already owns the wire→lens half, and it
 * is a plain function precisely so every door resolves scope identically. The
 * OTHER half — turning the two resolved lenses into predicates on THIS table's
 * columns — was inline in `queryUserSessions`, which was fine while there was
 * exactly one read door. There are now two (`list` and the owed-slot read), and
 * a hand-mirrored copy in the second is how a lens forks: one door narrows on
 * `projectId`, the other silently does not, and a "pod-wide" read quietly means
 * two different populations.
 *
 * The floor is NOT here. `focus_sessions` is owner-private and carries no
 * `VisibilityRule`, so `eq(userId)` is an explicit predicate every caller adds
 * first — visible at each door rather than buried in a helper that could one day
 * be called without it.
 *
 * Semantics, unchanged from the door this was lifted out of:
 *   - workspace lens: `null` → pod-personal (`workspaceId IS NULL`); `"<id>"` →
 *     that workspace; non-empty `string[]` → that SET; `undefined`/`[]` → no
 *     narrow.
 *   - project lens: `"<id>"`/non-empty `string[]` → the session's own
 *     `projectId` column (sessions carry it directly — a simple eq/inArray, NOT
 *     `exposureLensWhere`); `null`/`undefined`/`[]` → no narrow.
 *
 * An empty array never narrows (it must not mean "match zero"): a lens can only
 * restrict a floor, never empty it.
 */

import { eq, inArray, isNull, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";
import type { ResolvedScope } from "../../utils/scope-filter.js";

export function sessionScopeConditions({
  workspaceLens,
  projectLens,
}: ResolvedScope): SQL[] {
  const conditions: SQL[] = [];

  if (workspaceLens === null) {
    conditions.push(isNull(focusSessions.workspaceId));
  } else if (Array.isArray(workspaceLens)) {
    if (workspaceLens.length > 0) {
      conditions.push(inArray(focusSessions.workspaceId, workspaceLens));
    }
  } else if (typeof workspaceLens === "string") {
    conditions.push(eq(focusSessions.workspaceId, workspaceLens));
  }

  if (Array.isArray(projectLens)) {
    if (projectLens.length > 0) {
      conditions.push(inArray(focusSessions.projectId, projectLens));
    }
  } else if (typeof projectLens === "string") {
    conditions.push(eq(focusSessions.projectId, projectLens));
  }

  return conditions;
}
