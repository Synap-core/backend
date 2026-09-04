/**
 * The `focus_sessions.status` vocabulary — re-export ONLY.
 *
 * The declaration MOVED to `@synap-core/types/focus-sessions` (a leaf module
 * with zero imports) because the browser now renders session lifecycle too, and
 * a backend-private constant would have forced a fourth hand-written copy of
 * these strings on the frontend.
 *
 * This file stays as the backend's spelling of that door so every existing
 * importer (`triage.ts`, `session-blocked-by.ts`, `complete-session.ts`,
 * `routers/focus-sessions.ts`, `routers/mcp/handlers/shared.ts`,
 * `routers/hub-protocol/rest/focus-sessions.ts`) is unchanged. Do NOT redeclare
 * anything here.
 */

export {
  OPEN_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  SESSION_STATUSES,
  UPDATABLE_SESSION_STATUSES,
  isTerminalSessionStatus,
} from "@synap-core/types/focus-sessions";
export type {
  OpenSessionStatus,
  TerminalSessionStatus,
  SessionStatus,
} from "@synap-core/types/focus-sessions";
