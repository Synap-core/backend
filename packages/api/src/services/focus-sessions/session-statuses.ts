/**
 * The `focus_sessions.status` vocabulary — ONE declaration.
 *
 * Lifted out of `routers/mcp/handlers/shared.ts` (which re-exports it, so its
 * existing importers are unchanged) because a SERVICE now needs it too: the
 * blocked-by reader filters blockers to the ones still in flight. That file
 * imports the whole hub-protocol router, so importing it from a service would
 * close an import cycle — and copying four strings into the service is exactly
 * the hand-mirrored-vocabulary defect this repo keeps paying for.
 *
 * A leaf module with zero imports, so anything may depend on it.
 */

/** Non-terminal statuses — a session still "in flight" for its owner. */
export const OPEN_SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
  "scheduled",
] as const;

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
 * to validate the model-supplied `status` filter — see synap_list_sessions.
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
