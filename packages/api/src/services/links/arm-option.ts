/**
 * THE arm rule (P5) on a read entity row, pure: a `blocked_by` edge may name
 * one option of a DECISION it waits on (`links.metadata.option`), and only an
 * option that decision lists (`decisionOptions`, keyed `value ?? label`). An
 * arm nobody can choose would never be taken, and the step would be skipped
 * for a typo.
 *
 * Said by the dependency door (`validateArmEdge`, `dependency-links.ts`) and
 * by a capture plan's preflight for an arm on an EXISTING decision
 * (`capture-plan-preflight.ts`), so a plan is refused at propose time with
 * the words approval would have used. A leaf: its only import is pure.
 */

import { decisionRecordView } from "@synap-core/types/ask";

/** The kind an arm waits on (the system `decision` profile). */
export const DECISION_KIND = "decision";

export const ARM_NOT_A_DECISION =
  "Only a wait on a decision can name an option (an arm).";

/** `null` when `option` is one of the decision's options, else the refusal. */
export function armOptionProblem(
  row: { type: string; properties: unknown } | null | undefined,
  option: string
): string | null {
  if (!row || row.type !== DECISION_KIND) return ARM_NOT_A_DECISION;
  const keys = decisionRecordView(row.properties).options.map((o) => o.key);
  if (keys.length === 0) {
    return "This decision lists no options (decisionOptions): give it its options, then name one.";
  }
  return keys.includes(option)
    ? null
    : `"${option}" is not an option of this decision. Its options: ${keys.map((k) => `"${k}"`).join(", ")}.`;
}
