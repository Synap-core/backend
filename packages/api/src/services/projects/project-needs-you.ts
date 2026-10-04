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
 * SESSION-KIND-LENS-EXEMPT: returns a count or a narrow {id, title, goal, updatedAt} projection for a needs-you signal row, never a session row; the population is projectPathConditions (kind + triage lens applied in SQL).
 */

import { db, focusSessions, and, desc, eq, inArray } from "@synap/database";
import { needsYouReason } from "@synap-core/types/units";
import { attachNextMove } from "../focus-sessions/session-path-sections.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";

/** How many open sessions one project's review scan reads before it is a floor. */
export const REVIEW_SCAN_LIMIT = 100;

/** One project session whose next move is the person's acceptance. */
export interface ReviewSessionRow {
  id: string;
  title: string | null;
  goal: string | null;
  /** When the session last moved — the row's `occurredAt`. */
  updatedAt: Date;
  /** The session's containers — the row's provenance door. */
  workspaceId: string | null;
  projectId: string | null;
  trackId: string | null;
}

/**
 * The count, derived from THE list — so a badge that counts review sessions
 * and a tray that lists them can never disagree (W2 "one number, one
 * predicate").
 */
export async function countProjectSessionsAwaitingReview(q: {
  userId: string;
  projectId: string;
  database?: typeof db;
}): Promise<{ review: number; truncated: boolean }> {
  const { sessions, truncated } = await listProjectSessionsAwaitingReview(q);
  return { review: sessions.length, truncated };
}

/** The review population as ROWS — what `signals.list` emits under a project. */
export function listProjectSessionsAwaitingReview(q: {
  userId: string;
  projectId: string;
  database?: typeof db;
}): Promise<{ sessions: ReviewSessionRow[]; truncated: boolean }> {
  return listSessionsAwaitingReview(q);
}

/**
 * The review population for ANY lens scope — pod (no lens), a workspace, a
 * project, a track or one session. ONE predicate at every scope (the project
 * path's population: `sessionListConditions` with the `default` triage lens,
 * work + tracked runs, owner floor), so pod ⊇ project ⊇ track ⊇ session by
 * construction: each lens only adds an AND. The project form above is this
 * call with `projectId` (it used `projectPathConditions`, which is this same
 * `sessionListConditions` call).
 *
 * `workspaceId` is the signals three-state: absent = no narrow, `null` =
 * pod-personal sessions only, an id = that workspace.
 */
export async function listSessionsAwaitingReview(q: {
  userId: string;
  workspaceId?: string | null;
  projectId?: string;
  trackId?: string;
  sessionId?: string;
  database?: typeof db;
}): Promise<{ sessions: ReviewSessionRow[]; truncated: boolean }> {
  const database = q.database ?? db;
  const conditions = sessionListConditions({
    userId: q.userId,
    scope: { workspaceLens: q.workspaceId, projectLens: q.projectId },
    status: "all",
    lens: "default",
    kind: "work",
    includeTrackedRuns: true,
    ...(q.trackId ? { trackId: q.trackId } : {}),
  });
  if (q.sessionId) conditions.push(eq(focusSessions.id, q.sessionId));
  const rows = await database
    .select()
    .from(focusSessions)
    .where(
      and(
        ...conditions,
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
    logContext: {
      ...(q.projectId ? { projectId: q.projectId } : {}),
      door: "sessionsAwaitingReview",
    },
  });
  const sessions = withFacts
    .filter((r) => needsYouReason(r.unitFacts) === "review")
    .map((r) => ({
      id: r.id,
      title: r.title ?? null,
      goal: r.goal ?? null,
      updatedAt: new Date(r.updatedAt),
      workspaceId: r.workspaceId ?? null,
      projectId: r.projectId ?? null,
      trackId: r.trackId ?? null,
    }));
  return { sessions, truncated };
}
