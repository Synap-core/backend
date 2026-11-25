/**
 * A builtin verb REFUSING a run: nothing ran, and the sentence says why and
 * what to do next.
 *
 * WHY: a builtin handler's only failure channel was a throw, and a throw from
 * the runner is AMBIGUOUS to the approval (`dispatchExternalOnce`: the claim is
 * kept, so Retry never re-runs) and UNCLASSIFIED (`classifyThrownFailure`:
 * `unknown`, shown as "an internal error occurred"). On 2026-11-10 the person
 * approved an agent's `computer.run_recipe` (proposal c6ba64e6) and read only
 * that, while the handler had refused with a sentence naming the fix.
 *
 * `runResolvedSkill` turns this error into its `{kind:"error"}` outcome (the
 * channel a provider verb's refusal already takes): a DEFINITE not-run, so the
 * approval releases its claim and records the sentence and the class. Any
 * other throw stays a throw: a crash is still a crash.
 */
import type { FailureErrorClass } from "@synap-core/types/failures";

export class VerbRefusal extends Error {
  override readonly name = "VerbRefusal";
  constructor(
    message: string,
    /** The failure class the approval records (its recovery affordance). */
    readonly errorClass: FailureErrorClass,
    /** The verb's own refusal code, for a program (`UNKNOWN_RECIPE`). */
    readonly code?: string
  ) {
    super(message);
  }
}

/**
 * Recognised by SHAPE as well as by class: the error may cross a module
 * boundary twice loaded (a test's mock), after which `instanceof` answers false.
 */
export function isVerbRefusal(err: unknown): err is VerbRefusal {
  return (
    err instanceof VerbRefusal ||
    (!!err &&
      typeof err === "object" &&
      (err as { name?: unknown }).name === "VerbRefusal" &&
      typeof (err as { errorClass?: unknown }).errorClass === "string" &&
      typeof (err as { message?: unknown }).message === "string")
  );
}
