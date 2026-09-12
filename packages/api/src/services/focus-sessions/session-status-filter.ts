/**
 * The `focus_sessions` STATUS APPLICATION — the one place a list door's status
 * filter becomes SQL. Lifted out of `queryUserSessions` for the reason
 * `session-scope.ts` and `session-kind.ts` were: a predicate inline in a router
 * cannot be tested without mocking the whole query chain, so it was not.
 *
 * ── WHY `closedSince` EXISTS ────────────────────────────────────────────────
 * Relay's Work tab shows every session that still wants you (the unconcluded
 * statuses) plus anything CLOSED in the last 24 hours, so the thread of what
 * you finished today survives. The second half is a TIME window, which a status
 * set cannot express.
 *
 * The first fix sent `closed` inside the status set and applied the 24h window
 * on the phone. Replayed against the live pod afterwards, it changed NOTHING:
 * of 34 `work` rows, 19 qualified and both the old and the new request rendered
 * 11. Nine sessions closed MORE than a day ago were fetched into the 20-slot
 * page and thrown away on the device — and because they sort newer by
 * `startedAt` than the months-old stale sessions, they are exactly what crowds
 * those out. The narrowing still happened after the limit; it had only moved
 * from one axis to another.
 *
 * So the window is a WHERE clause too. Every row this door returns is one the
 * caller renders, which is the same rule `sessionKindWhere` and the triage lens
 * state: filter in the query, never after the `limit`.
 *
 * ── SEMANTICS ───────────────────────────────────────────────────────────────
 *   - `"all"`                → no condition (`closedSince` is redundant).
 *   - one status / a set     → that status (`=`) or set (`IN`).
 *   - … plus `closedSince`   → OR a `closed` row concluded at/after that instant,
 *                              UNLESS `closed` is already selected, in which case
 *                              the window would only NARROW an explicit ask and
 *                              is ignored rather than silently applied.
 *
 * The conclusion clock is `coalesce(closed_at, updated_at)` — the same fallback
 * relay's `isWorkVisibleSession` uses, so the pod and the phone cannot disagree
 * about whether a row is inside the window.
 */

import {
  and,
  eq,
  inArray,
  or,
  drizzleSql,
  focusSessions,
} from "@synap/database";
import type { SQL } from "@synap/database";
import type { SessionStatus } from "./session-statuses.js";

export function sessionStatusConditions(
  status: SessionStatus | "all" | readonly SessionStatus[],
  closedSince?: string
): SQL[] {
  if (status === "all") return [];

  const selected: SQL = Array.isArray(status)
    ? // A set never means "match zero": `[]` is refused at the input schema
      // (`.nonempty()`), the same rule the workspace lens follows — a filter
      // may restrict a floor, never empty it.
      (inArray(focusSessions.status, [...status]) as SQL)
    : (eq(focusSessions.status, status as SessionStatus) as SQL);

  const closedAlreadySelected = Array.isArray(status)
    ? status.includes("closed")
    : status === "closed";
  if (!closedSince || closedAlreadySelected) return [selected];

  // Cast explicitly: an ISO string bound into a raw template is untyped, and a
  // `Date` object is the value postgres.js cannot bind here at all.
  const recentlyClosed = and(
    eq(focusSessions.status, "closed"),
    drizzleSql`coalesce(${focusSessions.closedAt}, ${focusSessions.updatedAt}) >= ${closedSince}::timestamptz`
  ) as SQL;

  return [or(selected, recentlyClosed) as SQL];
}
