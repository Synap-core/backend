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
  // A playbook's DECLARED requirements are part of its definition: a run
  // snapshots them, and changing them changes what the process asks the pod to
  // do. Omitting them here would let a requirements edit leave `version`
  // untouched, so the snapshot could not tell the two apart.
  "requiredIntents",
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
