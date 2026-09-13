/**
 * The `focus_sessions` STATUS APPLICATION — the one place a list door's status
 * filter becomes SQL. Lifted out of `queryUserSessions` for the reason
 * `session-scope.ts` and `session-kind.ts` were: a predicate inline in a router
 * cannot be tested without mocking the whole query chain, so it was not.
 *
 * ── WHY PER-STATUS WINDOWS EXIST ────────────────────────────────────────────
 * Relay's Work home shows the sessions that still want you, with two statuses
 * admitted only while RECENT (founder decisions):
 *   - `closed` for 24 hours, so the thread of what you finished today survives;
 *   - `stale` for 7 days (2026-09-13). The reaper stamps a session stale after
 *     24h idle, and they never conclude on their own: the live pod carried 14,
 *     mostly abandoned dogfood sessions from June and July, filling the home.
 *     Older stale sessions are still reachable on the full, searchable list.
 *
 * Both halves are TIME windows, which a status set cannot express. The first
 * attempt sent `closed` inside the set and applied the window on the phone.
 * Replayed against the live pod it changed NOTHING: 19 qualifying, 11 rendered
 * by both the old and the new request, because sessions closed long ago still
 * filled the limited page and were discarded on the device. So a window is a
 * WHERE clause too — the rule `sessionKindWhere` and the triage lens state:
 * filter in the query, never after the `limit`.
 *
 * ── SEMANTICS ───────────────────────────────────────────────────────────────
 *   - `"all"`                → no condition (windows are redundant).
 *   - one status / a set     → that status (`=`) or set (`IN`).
 *   - … plus `statusSince.X` → OR a row of status X whose last activity is at or
 *                              after that instant — UNLESS X is already selected,
 *                              in which case the window would only NARROW an
 *                              explicit ask, and it is ignored rather than
 *                              silently applied.
 *
 * The activity clock is `coalesce(closed_at, updated_at)`: the conclusion time
 * for a closed row, the last touch for a stale one (stale rows have no
 * `closed_at`). Relay's `isWorkVisibleSession` uses the same fallback, so the
 * pod and the phone cannot disagree about whether a row is inside a window.
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

/** The statuses that may be admitted by recency rather than by status alone. */
export const WINDOWED_SESSION_STATUSES = ["stale", "closed"] as const;
export type WindowedSessionStatus = (typeof WINDOWED_SESSION_STATUSES)[number];

/** ISO instants: admit rows of that status active at or after it. */
export type StatusSinceWindows = Partial<Record<WindowedSessionStatus, string>>;

export function sessionStatusConditions(
  status: SessionStatus | "all" | readonly SessionStatus[],
  statusSince?: StatusSinceWindows
): SQL[] {
  if (status === "all") return [];

  const selectedSet: readonly SessionStatus[] = Array.isArray(status)
    ? status
    : [status as SessionStatus];
  const selected: SQL = Array.isArray(status)
    ? // A set never means "match zero": `[]` is refused at the input schema
      // (`.nonempty()`), the same rule the workspace lens follows — a filter
      // may restrict a floor, never empty it.
      (inArray(focusSessions.status, [...status]) as SQL)
    : (eq(focusSessions.status, status as SessionStatus) as SQL);

  const windows: SQL[] = [];
  for (const windowed of WINDOWED_SESSION_STATUSES) {
    const since = statusSince?.[windowed];
    if (!since || selectedSet.includes(windowed)) continue;
    // Cast explicitly: an ISO string bound into a raw template is untyped, and
    // a `Date` object is the value postgres.js cannot bind here at all.
    windows.push(
      and(
        eq(focusSessions.status, windowed),
        drizzleSql`coalesce(${focusSessions.closedAt}, ${focusSessions.updatedAt}) >= ${since}::timestamptz`
      ) as SQL
    );
  }

  return windows.length === 0 ? [selected] : [or(selected, ...windows) as SQL];
}
