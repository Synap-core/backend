/**
 * Which playbook columns bump `version` — the snapshot a run records so
 * "what ran" can be diffed against "today". Metadata is absent on purpose:
 * a pin-list edit is the owner's bag, not a new definition.
 */
import { stableStringify } from "../../utils/stable-stringify.js";

export const DEFINITION_VERSION_FIELDS = [
  "goalTemplate",
  "stages",
  "params",
  "inputStrategy",
  "channelSpec",
  "expectedOutputs",
  "criteria",
  // What a run of it may use (0419, "only these") is part of its definition:
  // a run snapshots it, and changing it changes what the run can do. Omitting
  // it here would let a tools edit leave `version` untouched, so the snapshot
  // could not tell the two apart.
  "tools",
  // The rules it follows: a changed ref list changes what a run is told.
  // (A new VERSION of a referenced rule does not bump this; the run records
  // that through `guidance.used`, its content hashes.)
  "guidance",
  // Who runs it and the tools it needs (0416): a changed runner changes who a
  // run is handed to, a changed requires what is checked before it is.
  "runner",
  "requires",
] as const;

export function definitionVersionChanged(
  set: Record<string, unknown>,
  existing: Record<string, unknown>
): boolean {
  return DEFINITION_VERSION_FIELDS.some(
    (field) =>
      set[field] !== undefined &&
      stableStringify(set[field]) !== stableStringify(existing[field])
  );
}
