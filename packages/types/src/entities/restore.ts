/**
 * Typed refusals of `entities.restore`, carried as tRPC `error.data.reasonCode`.
 *
 * - `ENTITY_NOT_DELETED` (CONFLICT): the entity is live; there is nothing to
 *   restore (a second Undo, or a restore that already won).
 * - `ENTITY_GONE` (NOT_FOUND): no deleted row the caller may write: it was
 *   permanently deleted, or never existed, or is not theirs to restore. One
 *   code for the three, so a refusal never tells whether a row exists.
 */
export const ENTITY_RESTORE_REASON_CODES = {
  notDeleted: "ENTITY_NOT_DELETED",
  gone: "ENTITY_GONE",
} as const;

export type EntityRestoreReasonCode =
  (typeof ENTITY_RESTORE_REASON_CODES)[keyof typeof ENTITY_RESTORE_REASON_CODES];
