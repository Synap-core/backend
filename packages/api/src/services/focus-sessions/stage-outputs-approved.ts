/**
 * A STAGE'S DECLARED OUTPUTS, and whether they are APPROVED — approval signal
 * 1 of a stage's `onApproved` (decision D2, `stage-subject-status.ts`).
 *
 * A LEAF (no database, no door): the status writer and the slot merge
 * (`stage-slots.ts`) both read it, and the writer must not load the update
 * door to answer a pure question.
 */
import type { ExpectedOutput } from "@synap/playbooks";
import {
  deriveSlotKeys,
  isDeliverableDelivered,
} from "@synap-core/types/units";
import { normalizeExpectedLabel } from "./expected-label.js";

/** The declared outputs of stage `stageKey`, or [] (unknown stage, none declared). */
export function declaredStageOutputs(
  stages: unknown,
  stageKey: string | null
): ExpectedOutput[] {
  if (!stageKey || !Array.isArray(stages)) return [];
  const stage = stages.find(
    (s) =>
      !!s && typeof s === "object" && (s as { key?: unknown }).key === stageKey
  ) as { expectedOutputs?: unknown } | undefined;
  return Array.isArray(stage?.expectedOutputs)
    ? (stage.expectedOutputs as ExpectedOutput[])
    : [];
}

/**
 * Is stage `stageKey`'s declared work APPROVED — approval signal 1 of a
 * stage's `onApproved` (decision D2)? True when the stage declares outputs
 * and every one of them the session carries is settled: delivered (stamped
 * done by an approval, attested, decided by the person's answer —
 * `isDeliverableDelivered`, the one rule) or retired, with at least one
 * delivered. An optional output never holds it back. A declared output the
 * session does not carry yet (the stage was never entered) is not settled.
 * False for a stage with no declared outputs: its approval is the next
 * stage's gate (signal 2), or nothing. Matched like `stageSlotsToAdd` (`stage-slots.ts`):
 * declared key, else label (trim + casefold). PURE.
 */
export function stageOutputsApproved(
  stages: unknown,
  stageKey: string | null,
  current: readonly ExpectedOutput[]
): boolean {
  const declared = declaredStageOutputs(stages, stageKey);
  if (declared.length === 0) return false;
  const keys = deriveSlotKeys(current);
  let delivered = 0;
  for (const o of declared) {
    if ((o as { optional?: unknown }).optional === true) continue;
    const key = (o as { key?: unknown }).key;
    const label = normalizeExpectedLabel(o?.label);
    let at = typeof key === "string" ? keys.indexOf(key) : -1;
    if (at < 0 && label) {
      at = current.findIndex((c) => normalizeExpectedLabel(c?.label) === label);
    }
    const slot = at >= 0 ? current[at] : undefined;
    if (!slot) return false;
    if (isDeliverableDelivered(slot)) {
      delivered += 1;
      continue;
    }
    if ((slot as { retiredAt?: unknown }).retiredAt == null) return false;
  }
  return delivered > 0;
}
