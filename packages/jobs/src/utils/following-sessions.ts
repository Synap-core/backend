/**
 * The sessions a subject's status move reaches: in flight — the pod's open
 * statuses (`active`, `paused`, `forming`) — never a mere appointment
 * (`scheduled`). ONE set for both readers of "the open sessions about this
 * thing":
 *  - process-sync's follow (`process-sync.ts`): the run follows its subject;
 *  - the status door's stage-gate check (@synap/api
 *    `services/focus-sessions/subject-move-gate.ts`): a move into a status a
 *    gated stage owns goes through that gate, for exactly the sessions the
 *    follow would have moved.
 * Its own module, importing only the dependency-free status leaf, so a suite
 * that mocks the process loader never loses it.
 */
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";

export const FOLLOWING_SESSION_STATUSES = OPEN_SESSION_STATUSES.filter(
  (s) => s !== "scheduled"
);
