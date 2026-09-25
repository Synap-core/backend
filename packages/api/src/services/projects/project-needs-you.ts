/**
 * PROJECT NEEDS-YOU — the REVIEW half of THE needs-you rule, for one project.
 *
 * The rule (`@synap-core/types/units` `needs-you.ts`, founder decision N1,
 * 2026-09-25) has three populations: owed slots, pending decisions, and
 * sessions whose next move is the person's acceptance (`ready_to_close`).
 * `signals.countByProject` — the rail badge — already reads the first two
 * through their own doors (`focusSessions.owed`, `proposals.groups`). This is
 * the third: the project's sessions for which `needsYouReason(unitFacts)` is
 * `"review"`.
 *
 * ONE derivation all the way down, nothing re-derived here:
 *   - the session SET is `projectPathConditions` (the path's population and
 *     owner floor), narrowed to open sessions — `ready_to_close` is never
 *     answered for a terminal one;
 *   - `unitFacts` come from `attachNextMove` (the path/list batch, the packet's
 *     `deriveNextMove`);
 *   - membership is `needsYouReason`, so a draft is excluded by the rule, and
 *     the `default` triage lens keeps drafts from eating the scan cap in SQL.
 *
 * Capped: a project with more open sessions than the cap reports `truncated`,
 * and the count is a FLOOR — never a silent under-count.
 *
 * SESSION-KIND-LENS-EXEMPT: returns a count, never a session row; the population is projectPathConditions (kind + triage lens applied in SQL).
 */

import { db, focusSessions, and, desc, inArray } from "@synap/database";
import { needsYouReason } from "@synap-core/types/units";
import { attachNextMove } from "../focus-sessions/session-path-sections.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { projectPathConditions } from "./project-path.js";

/** How many open sessions one project's review scan reads before it is a floor. */
export const REVIEW_SCAN_LIMIT = 100;

export async function countProjectSessionsAwaitingReview(q: {
  userId: string;
  projectId: string;
  database?: typeof db;
}): Promise<{ review: number; truncated: boolean }> {
  const database = q.database ?? db;
  const rows = await database
    .select()
    .from(focusSessions)
    .where(
      and(
        ...projectPathConditions({
          userId: q.userId,
          projectId: q.projectId,
          lens: "default",
        }),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .orderBy(desc(focusSessions.startedAt), desc(focusSessions.id))
    .limit(REVIEW_SCAN_LIMIT + 1);
  const truncated = rows.length > REVIEW_SCAN_LIMIT;
  const page = rows.slice(0, REVIEW_SCAN_LIMIT);
  const withFacts = await attachNextMove(page, {
    userId: q.userId,
    database,
    logContext: { projectId: q.projectId, door: "projectNeedsYou" },
  });
  const review = withFacts.filter(
    (r) => needsYouReason(r.unitFacts) === "review"
  ).length;
  return { review, truncated };
}
