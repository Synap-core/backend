/**
 * UNDO FOR A SESSION UPDATE — which changes a revert can restore, decided ONCE.
 *
 * A session update is undoable only when every change it carries is one of
 * {@link SESSION_UNDO_COLUMNS}: plain columns whose earlier value can be put
 * back compare-and-set (`row_patch` in `safe-revert.ts`). Everything else a
 * session update can do has effects a column write cannot reverse — a stage
 * advance (gates, events), a status, the deliverables, the criteria, the
 * roster, the subject, a playbook follow, a space move (moves the room and its
 * artifacts) or a track filing (stamps project uses) — so such an update is
 * never stamped and revert says it cannot be undone.
 *
 * ALLOWLIST, fail-closed: a key this file does not name makes the update
 * unundoable, so a field added to the session update later can never be
 * offered an Undo that would silently leave it in place.
 *
 * The SAME predicate decides at the two apply sites (the direct write in
 * `update-session.ts` and the `focus_session/update` executor) and predicts for
 * a pending row (`wouldBeRevertable` in `routers/proposals/revert.ts`).
 */

/** The session columns an Undo restores. */
export const SESSION_UNDO_COLUMNS = [
  "title",
  "goal",
  "progress",
  "projectId",
] as const;

export type SessionUndoColumn = (typeof SESSION_UNDO_COLUMNS)[number];

/**
 * Keys a session-update payload (or the door's params) may carry and stay
 * undoable: the columns, plus identity and display keys that change nothing.
 * `goal` rides the payload only when the caller changes it, and
 * `previousGoal` is the goal at filing time that the executor compares
 * against (`session-update-goal.ts`). `sessionName` is display-only. Neither
 * is written to the row. The stamp records only the columns that actually
 * changed.
 */
const UNDOABLE_KEYS: ReadonlySet<string> = new Set<string>([
  ...SESSION_UNDO_COLUMNS,
  "id",
  "sessionId",
  "userId",
  "agentUserId",
  "projectName",
  "sessionName",
  "previousGoal",
]);

/** True when every defined key of `patch` is one an Undo can restore or ignore. */
export function isUndoableSessionPatch(patch: object): boolean {
  return Object.entries(patch).every(
    ([key, value]) => value === undefined || UNDOABLE_KEYS.has(key)
  );
}
