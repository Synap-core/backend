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
 */

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
