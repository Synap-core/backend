/**
 * Edit ONE stage of a playbook by its key, and know when a stage list was read
 * whole (tickets 8493079e, 2771d2bc, 18 Nov 2026).
 *
 * WHY: `synap_update_playbook`'s `stages` REPLACES the stored list, so adding
 * one stage meant re-sending all 14 (25 KB). The read an agent took that list
 * from is capped (`reply-cap.ts`): a large playbook comes back with its list
 * cut or its strings clipped, and writing that back deletes the stages it
 * lacked. Two answers here, both pure:
 *   - `applyStageEdits`: add, update or remove one stage by key against the
 *     STORED list, so the caller never re-sends the rest;
 *   - `stagesRevision`: a fingerprint of the stored list. A read that holds
 *     the list whole carries it; a whole-list write must hand it back, so a
 *     list from a cut read (which carries none) is refused, and so is one
 *     read before somebody else changed the stages.
 * The result still goes through `playbooks.update`, whose
 * `playbookStagesSchema` validates every stage and refuses a duplicate key.
 */
import { createHash } from "node:crypto";

type Stage = Record<string, unknown>;

/** At most this many edits in one call. */
export const STAGE_EDITS_MAX = 50;

/** Keys named in a refusal, at most. */
const KEYS_NAMED_MAX = 30;

/** The fingerprint of a stored stage list (its jsonb, as the pod reads it). */
export function stagesRevision(stages: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(Array.isArray(stages) ? stages : []))
    .digest("hex")
    .slice(0, 16);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const keyOf = (s: unknown): string | null =>
  isRecord(s) && typeof s.key === "string" ? s.key : null;

function knownKeys(stages: readonly Stage[]): string {
  const keys = stages.map(keyOf).filter((k): k is string => !!k);
  if (keys.length === 0) return "it has no stages";
  const shown = keys.slice(0, KEYS_NAMED_MAX).join(", ");
  return keys.length > KEYS_NAMED_MAX
    ? `its keys: ${shown} and ${keys.length - KEYS_NAMED_MAX} more`
    : `its keys: ${shown}`;
}

/**
 * `edits` applied in order to `stored`: `{op:'add', stage, after?}` inserts a
 * stage (after the stage keyed `after`, else at the end), `{op:'update', key,
 * fields}` merges fields into one stage (a `null` field is removed),
 * `{op:'remove', key}` drops one. The first edit that cannot apply refuses the
 * whole call, naming it; nothing is half-applied.
 */
export function applyStageEdits(
  stored: unknown,
  edits: unknown
): { ok: true; stages: Stage[] } | { ok: false; error: string } {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "stageEdits must be a non-empty array." };
  }
  if (edits.length > STAGE_EDITS_MAX) {
    return {
      ok: false,
      error: `stageEdits takes at most ${STAGE_EDITS_MAX} edits in one call.`,
    };
  }
  let stages: Stage[] = (Array.isArray(stored) ? stored : []).filter(isRecord);
  const at = (key: string) => stages.findIndex((s) => keyOf(s) === key);
  for (const [i, edit] of edits.entries()) {
    const where = `stageEdits[${i}]`;
    if (!isRecord(edit)) {
      return { ok: false, error: `${where} must be an object.` };
    }
    if (edit.op === "add") {
      const stage = edit.stage;
      const key = keyOf(stage);
      if (!isRecord(stage) || !key) {
        return {
          ok: false,
          error: `${where}: an add needs \`stage\`, a whole stage with its \`key\`.`,
        };
      }
      if (at(key) !== -1) {
        return {
          ok: false,
          error: `${where}: the playbook already has a stage "${key}": update it instead.`,
        };
      }
      if (edit.after === undefined) {
        stages = [...stages, stage];
        continue;
      }
      const after = typeof edit.after === "string" ? at(edit.after) : -1;
      if (after === -1) {
        return {
          ok: false,
          error: `${where}: no stage "${String(edit.after)}" to add after (${knownKeys(stages)}).`,
        };
      }
      stages = [
        ...stages.slice(0, after + 1),
        stage,
        ...stages.slice(after + 1),
      ];
      continue;
    }
    if (edit.op !== "update" && edit.op !== "remove") {
      return {
        ok: false,
        error: `${where}: op must be 'add', 'update' or 'remove'.`,
      };
    }
    const index = typeof edit.key === "string" ? at(edit.key) : -1;
    if (index === -1) {
      return {
        ok: false,
        error: `${where}: no stage "${String(edit.key)}" (${knownKeys(stages)}).`,
      };
    }
    if (edit.op === "remove") {
      stages = stages.filter((_, j) => j !== index);
      continue;
    }
    if (!isRecord(edit.fields)) {
      return {
        ok: false,
        error: `${where}: an update needs \`fields\`, the stage fields to change.`,
      };
    }
    if (edit.fields.key !== undefined && edit.fields.key !== edit.key) {
      return {
        ok: false,
        error: `${where}: a stage's key is what sessions store; to rename it, remove the stage and add it again.`,
      };
    }
    const merged: Stage = { ...stages[index]! };
    for (const [field, value] of Object.entries(edit.fields)) {
      if (value === null) delete merged[field];
      else merged[field] = value;
    }
    stages = stages.map((s, j) => (j === index ? merged : s));
  }
  return { ok: true, stages };
}
