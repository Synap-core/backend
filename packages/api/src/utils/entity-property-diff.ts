/**
 * What a merge wrote onto a PRE-EXISTING entity, with the values it replaced.
 *
 * A strong-identity dedup does not create a row — it enriches one that was
 * already there. Revert must never delete that entity (it is somebody's), but
 * it must be able to put back what the run overwrote. So the merge records,
 * per key, the prior value and the value it wrote; revert restores a key only
 * while it still holds the written value (a key edited since is left alone).
 *
 * JSON cannot hold `undefined`, so "the key did not exist before" is a list
 * (`absentBefore`), never a missing entry in `before`.
 */

export interface EntityPropertyDiff {
  entityId: string;
  /** Prior value of every changed key that EXISTED before the merge. */
  before: Record<string, unknown>;
  /** Value the merge wrote, for every changed key. */
  after: Record<string, unknown>;
  /** Changed keys that did not exist before the merge. */
  absentBefore: string[];
  /**
   * Body document the merge linked onto an entity that had none. Revert
   * unlinks it only while the entity still points at it.
   */
  bodyDocumentId?: string;
  /**
   * Keys the write REMOVED (an update's `deleteProperties`). Their prior value
   * is in `before`; revert restores one only while it is still absent.
   */
  absentAfter?: string[];
  /**
   * Entity COLUMNS an update changed (title; `preview` is the description).
   * Revert restores one only while it still holds the written value.
   */
  fields?: {
    before: Partial<Record<EntityDiffField, string | null>>;
    after: Partial<Record<EntityDiffField, string | null>>;
  };
}

/** The entity columns an update can change and revert can restore. */
export type EntityDiffField = "title" | "preview";
export const ENTITY_DIFF_FIELDS: readonly EntityDiffField[] = [
  "title",
  "preview",
];

/**
 * The API field name of an entity column: the `preview` column is the
 * `description` field on every entity door, so a column named to a client or
 * in a receipt reads the way every other field does.
 */
export function entityFieldApiName(field: EntityDiffField): string {
  return field === "preview" ? "description" : field;
}

/** The slice of an entity row an update diff is computed from. */
export interface EntityUndoSnapshot {
  title: string | null;
  preview: string | null;
  properties: unknown;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff `applied` against `prior`. Returns null when nothing changed, so a merge
 * that only re-stated existing values records nothing to restore.
 */
export function computeEntityPropertyDiff(
  entityId: string,
  prior: Record<string, unknown> | null | undefined,
  applied: Record<string, unknown>
): EntityPropertyDiff | null {
  const priorProps = prior ?? {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const absentBefore: string[] = [];
  for (const [key, value] of Object.entries(applied)) {
    if (Object.prototype.hasOwnProperty.call(priorProps, key)) {
      if (sameValue(priorProps[key], value)) continue;
      before[key] = priorProps[key];
    } else {
      absentBefore.push(key);
    }
    after[key] = value;
  }
  if (Object.keys(after).length === 0) return null;
  return { entityId, before, after, absentBefore };
}

/**
 * What an entity UPDATE changed, read from the row before and after the write
 * — the apply-time record revert reads. Every changed property key is
 * recorded (validation can normalize keys the caller never named, and those
 * changed too); a key the write removed goes to `absentAfter`. Returns null
 * when the write changed nothing.
 */
export function computeEntityUpdateDiff(
  entityId: string,
  prior: EntityUndoSnapshot,
  written: EntityUndoSnapshot
): EntityPropertyDiff | null {
  const priorProps = (prior.properties ?? {}) as Record<string, unknown>;
  const writtenProps = (written.properties ?? {}) as Record<string, unknown>;
  const diff = computeEntityPropertyDiff(
    entityId,
    priorProps,
    writtenProps
  ) ?? {
    entityId,
    before: {},
    after: {},
    absentBefore: [],
  };
  const absentAfter = Object.keys(priorProps).filter(
    (key) => !Object.prototype.hasOwnProperty.call(writtenProps, key)
  );
  for (const key of absentAfter) diff.before[key] = priorProps[key];
  if (absentAfter.length > 0) diff.absentAfter = absentAfter;

  const fieldsBefore: Partial<Record<EntityDiffField, string | null>> = {};
  const fieldsAfter: Partial<Record<EntityDiffField, string | null>> = {};
  for (const field of ENTITY_DIFF_FIELDS) {
    if (prior[field] === written[field]) continue;
    fieldsBefore[field] = prior[field];
    fieldsAfter[field] = written[field];
  }
  if (Object.keys(fieldsAfter).length > 0) {
    diff.fields = { before: fieldsBefore, after: fieldsAfter };
  }

  const changed =
    Object.keys(diff.after).length > 0 ||
    absentAfter.length > 0 ||
    !!diff.fields;
  return changed ? diff : null;
}
