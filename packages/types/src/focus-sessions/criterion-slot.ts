import type { Ask } from "../ask/index.js";

/**
 * The `ExpectedOutput.kind` an ESCALATED criterion is filed under, when the
 * automatic attempts are exhausted and the human must grade it.
 *
 * ONE definition, and it lives HERE rather than beside the service that writes
 * it, because the readers are UIs: a needs-you tray must tell a criterion slot
 * from an ordinary deliverable, since it takes a DIFFERENT verb — a grade,
 * never "I did this" / attest. `@synap-core/types` is the only backend package
 * the browser and relay can resolve (neither links the `@synap/*` scope), and
 * `@synap/playbooks` is deliberately dependency-free, so it cannot be the home
 * either.
 */
export const CRITERION_SLOT_KIND = "criterion";

/**
 * The answers a criterion slot's grade takes: the option VALUES of its ask
 * (`CRITERION_SLOT_ASK`, packages/api `evaluations/record.ts`), which the
 * answer door reads as the verdict (`criterionVerdictOf`).
 */
export const CRITERION_GRADE_VALUES = ["pass", "fail"] as const;

/**
 * Whether a criterion slot's ask IS its grade: a choice whose every option is
 * a grade value, with no free text. Answered through the slot's answer door
 * (`focusSessions.answerOutput`), such an answer is recorded as the grade
 * (`gradeCriterionAsOwner`), so a surface may draw it in place. Any other ask
 * on a criterion slot (none, or one an agent rewrote) would mark the slot
 * answered while the verdict never moves: it is graded on the scorecard.
 */
export function isCriterionGradeAsk(ask: Ask | null | undefined): boolean {
  if (ask?.mode !== "choose" || ask.allowOther === true) return false;
  const grades: readonly string[] = CRITERION_GRADE_VALUES;
  return (
    ask.options.length > 0 &&
    ask.options.every((o) => grades.includes(o.value ?? o.label))
  );
}
