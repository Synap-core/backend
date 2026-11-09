/**
 * The sessions a subject's status move reaches: in flight (`active`, `paused`,
 * `forming`), never a mere appointment. ONE set for both readers of "the open
 * sessions about this thing":
 *  - process-sync's follow (`process-sync.ts`): the run follows its subject;
 *  - the status door's stage-gate check (@synap/api
 *    `services/focus-sessions/subject-move-gate.ts`): a move into a status a
 *    gated stage owns goes through that gate, for exactly the sessions the
 *    follow would have moved.
 * Its own module, with no imports, so a suite that mocks the process loader
 * never loses it.
 */
export const FOLLOWING_SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
] as const;
