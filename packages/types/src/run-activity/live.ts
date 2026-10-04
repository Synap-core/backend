/**
 * "IS AN AGENT WORKING ON THIS RIGHT NOW?" — ONE rule, every surface.
 *
 * Founder decision D1 (2026-10-04): a session is working right now when an IS
 * turn is IN FLIGHT, or when ANY session activity was recorded in the last
 * `SESSION_WORKING_WINDOW_MS`. Both facts come from the pod's liveness read
 * (`live` on `focusSessions.activity` and on `focusSessions.list` rows — one
 * server function computes both), so:
 *
 *   - the Now line's live mode (`deriveRunActivity`),
 *   - the session header / hero state mark (`sessionUnitInput`),
 *   - the session list rows' mark,
 *
 * all read THIS predicate, and a header can no longer say "working" while the
 * line beside it says the last step was hours ago.
 *
 * Pure: the clock is a parameter. A surface that renders the answer must also
 * re-render when it FLIPS (`workingFlipInMs`) — no new data arrives when a
 * session merely goes quiet.
 */

/** How recent the newest activity must be for a session to read as working. */
export const SESSION_WORKING_WINDOW_MS = 5 * 60_000;

/** The two liveness facts the rule reads. Structural — `SessionActivityLive` fits. */
export interface SessionLiveFacts {
  /** An IS turn is running in the session's room (a recorded fact). */
  turnInFlight: boolean;
  /** The newest recorded activity; null when nothing has happened yet. */
  lastAt: Date | string | null;
}

function timeOf(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * THE rule. A turn in flight, or activity no older than the window. A future
 * `lastAt` (clock skew between pod and device) counts as recent, never as
 * stale — the activity did happen.
 */
export function isSessionWorkingNow(
  live: SessionLiveFacts | null | undefined,
  now: number = Date.now()
): boolean {
  if (!live) return false;
  if (live.turnInFlight) return true;
  const last = timeOf(live.lastAt);
  return last !== null && now - last <= SESSION_WORKING_WINDOW_MS;
}

/**
 * Milliseconds until the answer above flips from working to not working on
 * its own (the window lapses), or `null` when it cannot flip without new data
 * (a turn in flight, or already quiet). A surface schedules one re-render at
 * that instant; a poll returning identical data re-renders nothing.
 */
export function workingFlipInMs(
  live: SessionLiveFacts | null | undefined,
  now: number = Date.now()
): number | null {
  if (!live || live.turnInFlight) return null;
  const last = timeOf(live.lastAt);
  if (last === null) return null;
  const remaining = last + SESSION_WORKING_WINDOW_MS - now;
  return remaining >= 0 ? remaining + 1 : null;
}
