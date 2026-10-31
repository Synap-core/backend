/**
 * UNDO FOR A SESSION UPDATE — which changes a revert can restore, decided ONCE.
 *
 * A session update is undoable only when every change it carries is one of
 * {@link SESSION_UNDO_COLUMNS}: plain columns whose earlier value can be put
 * back compare-and-set (`row_patch` in `safe-revert.ts`). Everything else a
 * session update can do has effects a column write cannot reverse — a stage
 * advance (gates, events), a status, the deliverables, the
 * roster, the subject, a playbook follow, a space move (moves the room and its
 * artifacts) — so such an update is never stamped and revert says it cannot be
 * undone.
 *
 * A GOAL (track) filing is undoable only when it writes no `uses` stamp
 * (founder D1 + wave lead decision a', 2026-10-29): filing a session that sits
 * in a space other than the goal's project home stamps `project --uses-->
 * space` (`stampTrackFilingUses`), and an Undo cannot take that index edge
 * back, so that filing stays unundoable. A session in no space, or in the
 * project's home space, writes no stamp: its filing is the `trackId` /
 * `trackStage` columns (and `projectId` when the session had none), which the
 * row patch restores exactly. The caller says which case it is
 * (`trackFilingWithoutUses`, decided by {@link trackFilingStampsUses});
 * without that word a track filing is never undoable — the executor and the
 * pending-row prediction never pass it.
 *
 * ALLOWLIST, fail-closed: a key this file does not name makes the update
 * unundoable, so a field added to the session update later can never be
 * offered an Undo that would silently leave it in place.
 *
 * The SAME predicate decides at the two apply sites (the direct write in
 * `update-session.ts` and the `focus_session/update` executor) and predicts for
 * a pending row (`wouldBeRevertable` in `routers/proposals/revert.ts`).
 */

/** The plain columns an Undo restores, whatever the update. */
const PLAIN_UNDO_COLUMNS = [
  "title",
  "goal",
  "progress",
  "projectId",
  // The acceptance contract (plan d679e92c C6): an agent's change to its own
  // session's criteria applies directly and must be revertible. The column is
  // the whole contract — the grades live in `session_evaluations`, never on
  // the row — so the compare-and-set row patch restores it exactly, and
  // refuses once anything rewrote the list since.
  "criteria",
] as const;

/** A goal filing's columns: restored only for a filing with no `uses` stamp. */
const TRACK_FILING_UNDO_COLUMNS = ["trackId", "trackStage"] as const;

/** The session columns an Undo restores (the `row_patch` allowlist). */
export const SESSION_UNDO_COLUMNS = [
  ...PLAIN_UNDO_COLUMNS,
  ...TRACK_FILING_UNDO_COLUMNS,
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
  ...PLAIN_UNDO_COLUMNS,
  "id",
  "sessionId",
  "userId",
  "agentUserId",
  "projectName",
  "sessionName",
  "previousGoal",
  // The open sub-sessions a filing carries (`session-tree-filing.ts`): each
  // one's filing columns are stamped as its own row patch on the same record.
  "subSessionIds",
]);

const TRACK_FILING_KEYS: ReadonlySet<string> = new Set<string>(
  TRACK_FILING_UNDO_COLUMNS
);

/** True when every defined key of `patch` is one an Undo can restore or ignore. */
export function isUndoableSessionPatch(
  patch: object,
  opts: {
    /** The patch's goal filing writes no `uses` stamp ({@link trackFilingStampsUses}). */
    trackFilingWithoutUses?: boolean;
  } = {}
): boolean {
  return Object.entries(patch).every(
    ([key, value]) =>
      value === undefined ||
      UNDOABLE_KEYS.has(key) ||
      (opts.trackFilingWithoutUses === true && TRACK_FILING_KEYS.has(key))
  );
}

/**
 * Would filing a session in `sessionWorkspaceId` into this goal stamp
 * `project --uses--> space`? The ONE condition `stampTrackFilingUses` writes
 * under, and what decides whether the filing can be undone (above) and so
 * whether an agent's own filing may be applied on a receipt
 * (`own-organise.ts`). An unfile stamps nothing.
 */
export function trackFilingStampsUses(
  filing: {
    set: { trackId: string | null };
    projectWorkspaceId: string | null;
  },
  sessionWorkspaceId: string | null
): boolean {
  return (
    !!filing.set.trackId &&
    !!sessionWorkspaceId &&
    sessionWorkspaceId !== filing.projectWorkspaceId
  );
}
