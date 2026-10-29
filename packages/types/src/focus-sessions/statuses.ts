/**
 * The `focus_sessions.status` vocabulary — ONE declaration, platform-wide.
 *
 * Lives in `@synap-core/types` (a leaf module with ZERO imports, safe in
 * browser, Electron, Node and CLI) because the backend is no longer the only
 * consumer: the browser renders a session's lifecycle and would otherwise mint
 * a fourth hand-written copy of these strings — the hand-mirrored-vocabulary
 * defect this platform keeps paying for.
 *
 * `packages/api/src/services/focus-sessions/session-statuses.ts` re-exports
 * these, so every existing backend importer is unchanged.
 *
 * A lockstep tripwire (`__tripwires__/declared-enum-covers-column.test.ts`)
 * asserts `SESSION_STATUSES` covers the `focus_sessions.status` column enum, so
 * a new stored state can never exist that this list does not know about.
 *
 * Its one import is a TYPE (erased): the module stays dependency-free at run
 * time.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";

/** Non-terminal statuses — a session still "in flight" for its owner. */
export const OPEN_SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
  "scheduled",
] as const;
export type OpenSessionStatus = (typeof OPEN_SESSION_STATUSES)[number];

/**
 * Terminal statuses — the lifecycle exits. Every one of them MUST go through
 * `completeFocusSession` (pack + run close + ephemeral expiry + close event);
 * a door that stamps one of these directly is the dual-path defect.
 */
export const TERMINAL_SESSION_STATUSES = [
  "closed",
  "cancelled",
  "failed",
] as const;
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

export function isTerminalSessionStatus(
  v: string | null | undefined
): v is TerminalSessionStatus {
  return (
    v != null && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * A CLOSED RUN STAYS CLOSED (work model R8). A session that ended — closed,
 * cancelled or failed — never moves back to an open status through an update
 * door: more work is a NEW run (rerun, or start a session). Every door that
 * writes `status` asks this one function: tRPC `focusSessions.update`, the
 * MCP/Hub service `updateFocusSession`, Hub REST `PATCH /focus-sessions/:id`
 * and the `focus_session/update` approval replay. `null` = allowed.
 *
 * Narrow on purpose: a terminal → terminal relabel (closed → cancelled) is not
 * a reopening and is not refused here.
 */
export function closedRunRefusal(
  from: string | null | undefined,
  to: string | null | undefined
): string | null {
  if (to == null || from === to) return null;
  if (!isTerminalSessionStatus(from) || isTerminalSessionStatus(to)) {
    return null;
  }
  return `This run is ${from} — a closed run stays closed. Start a new run to keep working.`;
}

/**
 * Suspended statuses — resumable, and not moving: `paused` by a person, or
 * `stale` (the reaper found the session quiet). NOT terminal: either can pick
 * up again. THE ONE READING of `stale` for a person-facing state filter —
 * Work › Sessions files it with Paused through this set, never beside Done.
 * (Activity's outcome for a session row is a different axis — how an act
 * ended — and draws `stopped` with the same pause mark.)
 */
export const SUSPENDED_SESSION_STATUSES = ["paused", "stale"] as const;
export type SuspendedSessionStatus =
  (typeof SUSPENDED_SESSION_STATUSES)[number];

export function isSuspendedSessionStatus(
  v: string | null | undefined
): v is SuspendedSessionStatus {
  return (
    v != null && (SUSPENDED_SESSION_STATUSES as readonly string[]).includes(v)
  );
}

/**
 * Every `focus_sessions.status` value (mirrors the schema's column enum). Used
 * to validate a model-supplied `status` filter — see synap_list_sessions — and
 * to derive the zod enums on the tRPC and Hub REST doors.
 */
export const SESSION_STATUSES = [
  ...OPEN_SESSION_STATUSES,
  "closed",
  "failed",
  "cancelled",
  // Added by the focus-session reaper (a long-idle `running` session is marked
  // stale rather than deleted). Must be listable, or list_sessions({status:
  // "stale"}) rejects a status the schema legitimately produces.
  "stale",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * The states a CLIENT may write. Every stored state EXCEPT `stale`, which only
 * the focus-session reaper stamps — a caller declaring its own session stale is
 * a category error.
 *
 * DERIVED from `SESSION_STATUSES` so a new stored state is writable by default
 * and the one exclusion stays a single, visible decision, instead of the two
 * hand-mirrored seven-string literals the tRPC `focusSessions.update` input and
 * the Hub REST `PATCH` body each used to carry.
 *
 * Typed as a non-empty tuple because `z.enum` requires one; that cast lives
 * here, once, rather than at each door.
 */
export const UPDATABLE_SESSION_STATUSES = SESSION_STATUSES.filter(
  (s): s is Exclude<SessionStatus, "stale"> => s !== "stale"
) as [Exclude<SessionStatus, "stale">, ...Exclude<SessionStatus, "stale">[]];

/**
 * THE session lifecycle, declared ONCE like a goal's
 * (`TRACK_STATUS_DECLARATION`): each stored status's fixed CATEGORY. Keyed by
 * every status, so a status added to {@link SESSION_STATUSES} and not
 * classified here stops the build. Read by the session transition
 * (`setSessionStatus`, @synap/database) and by any status rollup.
 *
 *   open    forming, scheduled — not started;
 *   active  active;
 *   paused  paused (a person or a check gate), stale (the reaper found it
 *           quiet). `stale` KEEPS its stored value (founder decision
 *           2026-09-13: Relay's Work home admits it for 7 days, and the
 *           reaper matches `active`/`paused` only, so a stale row stored as
 *           `paused` would be re-reaped every hour); it only READS as paused;
 *   done    closed;
 *   lost    failed, cancelled.
 */
export const SESSION_STATUS_DECLARATION = {
  forming: { category: "open" },
  scheduled: { category: "open" },
  active: { category: "active" },
  paused: { category: "paused" },
  stale: { category: "paused" },
  closed: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<SessionStatus, { category: LifecycleCategory }>;

/** The category of a session status; `null` for a value no status declares. */
export function sessionStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  if (status == null) return null;
  return Object.hasOwn(SESSION_STATUS_DECLARATION, status)
    ? SESSION_STATUS_DECLARATION[status as SessionStatus].category
    : null;
}
