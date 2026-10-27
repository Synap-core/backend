/**
 * The IoC slot that reaches the ONE observation writer (@synap/api
 * `recordObservation`) from an automation's `record_observation` output step:
 * a flow that reads an outside service's webhook records what happened there
 * (`dev.pr_merged`, `ci.finished`) as an observation, in process — the same
 * event, trigger hop and pod consumers as a producer's fact posted to
 * `observations.append`, never a self-POST to the pod's own URL.
 *
 * WHY A SLOT: `@synap/api` depends on `@synap/jobs`, so jobs never imports
 * api (the `stage-advance.ts` / `session-close.ts` inversion). apps/api fills
 * it at boot with api's `recordObservationFromAutomation`, which runs the
 * observation door's own checks (type namespace and phase, reserved subject
 * types, the dev-loop payload contract) before it writes.
 *
 * FAIL-CLOSED: unfilled, it THROWS — a step that could not reach the writer
 * fails visibly instead of reporting a fact it never recorded.
 */

export interface AutomationObservation {
  /** `<namespace>.<rest>` (`dev.pr_merged`), refused like the door refuses it. */
  type: string;
  /** What it is about, as the outside service names it (`owner/name#12`). */
  subjectId: string;
  subjectType?: string;
  data: Record<string, unknown>;
  occurredAt?: string;
  /** The automation's OWNER: the person the fact is recorded for. */
  ownerId: string;
  /** The automation's own workspace — never a value read from the config. */
  workspaceId: string;
  /** The recording run's chain, so the trigger hop's cycle guard sees it. */
  automationContext: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId?: string;
    chainAutomationIds?: string[];
  };
}

export type ObservationDoor = (
  input: AutomationObservation
) => Promise<{ id: string }>;

let door: ObservationDoor | null = null;

export function registerObservationDoor(d: ObservationDoor): void {
  door = d;
}

/** Test seam: forget the registered door. */
export function resetObservationDoorForTests(): void {
  door = null;
}

/** The registered door. Throws when unfilled — see FAIL-CLOSED above. */
export function observationDoor(): ObservationDoor {
  if (!door) {
    throw new Error(
      "observation door unregistered — refusing to report an observation the " +
        "pod could not record (apps/api fills this slot at boot)"
    );
  }
  return door;
}
