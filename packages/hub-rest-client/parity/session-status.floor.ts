/**
 * COMPILE FLOOR — the session status union this zero-dependency package
 * publishes (`FocusSessionStatus`) must stay EQUAL to the canonical one
 * (`SessionStatus` in `@synap-core/types/focus-sessions`), which the
 * `focus_sessions.status` column is pinned to. Before this floor the copy was
 * hand-typed and nothing checked it: a status the pod grew would have been
 * refused by every client filter typed against it.
 *
 * Why a mirror at all, and why outside `src/`: see `space-brief.floor.ts`.
 * Run by `pnpm typecheck` (tsconfig.parity.json).
 *
 * WHAT IT CANNOT SEE: the other session status copies outside this repo
 * (relay `useSessions.ts`, synap-app sdk `PodSessionStatus`); they import or
 * pin `SESSION_STATUSES` in their own repos.
 */
import type {
  SessionStatus,
  UPDATABLE_SESSION_STATUSES,
} from "../../types/src/focus-sessions/statuses.js";
import type {
  FocusSessionStatus,
  UpdatableFocusSessionStatus,
} from "../src/types.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _sessionStatus: Same<FocusSessionStatus, SessionStatus> = true;
export const _updatable: Same<
  UpdatableFocusSessionStatus,
  (typeof UPDATABLE_SESSION_STATUSES)[number]
> = true;
