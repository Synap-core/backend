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
