/**
 * The IoC slot that reaches the session OUTCOME doors (@synap/api) from an
 * automation's output step — `complete_outcome`, `post_evidence`,
 * `reevaluate_criterion` (plan v5 T2, decision V4: "automations may mark an
 * outcome met, post evidence and re-check a criterion, governed").
 *
 * WHY A SLOT: `@synap/api` depends on `@synap/jobs`, so jobs never imports
 * api (the `stage-advance.ts` / `session-close.ts` inversion). apps/api fills
 * it at boot with api's `sessionOutcomeDoor`.
 *
 * WHAT IT IS NOT: a governance bypass. The output step decides first, through
 * the automation door's own ladder (`checkAutomationWriteOrPropose`, shared
 * with `checkPermissionOrPropose`); this slot is reached only on a GRANT. A
 * proposal carries the same patch to the `focus_session/update` executor,
 * which applies it through the same api functions on approval.
 *
 * FAIL-CLOSED: unfilled, it THROWS — a step that could not reach the door
 * fails visibly instead of reporting an outcome it never wrote.
 */

/** The verdict of a `complete_outcome` (api `CompleteOutputOutcome.result`). */
export interface OutcomeCompletion {
  result: "completed" | "claimed" | "refused" | "no_match";
  message?: string;
}

/** What a grading call recorded (api `evaluateSession`). */
export interface OutcomeGrading {
  status: "evaluated" | "not_found";
  recorded: number;
  skipped: number;
}

export interface SessionOutcomeDoor {
  completeOutcome(input: {
    sessionId: string;
    /** The session's OWNER — every slot door's floor. */
    userId: string;
    outcomeKey: string;
  }): Promise<OutcomeCompletion>;
  postEvidence(input: {
    sessionId: string;
    userId: string;
    agentUserId?: string | null;
    evidence: Record<string, { passed: boolean; detail?: string }>;
  }): Promise<OutcomeGrading>;
  reevaluateCriteria(input: {
    sessionId: string;
    userId: string;
    agentUserId?: string | null;
    criterionKeys: string[];
  }): Promise<OutcomeGrading>;
}

let door: SessionOutcomeDoor | null = null;

export function registerSessionOutcomeDoor(d: SessionOutcomeDoor): void {
  door = d;
}

/** Test seam: forget the registered door. */
export function resetSessionOutcomeDoorForTests(): void {
  door = null;
}

/** The registered door. Throws when unfilled — see FAIL-CLOSED above. */
export function sessionOutcomeDoor(): SessionOutcomeDoor {
  if (!door) {
    throw new Error(
      "session outcome door unregistered — refusing to report an outcome, " +
        "evidence or grade the pod could not write (apps/api fills this slot at boot)"
    );
  }
  return door;
}
