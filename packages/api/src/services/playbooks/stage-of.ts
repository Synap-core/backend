/**
 * The STEP a child run works (runner engine slice 4, spec 7111934d §3.2): a
 * stage of a parent run that `uses` a playbook starts that playbook as its
 * own run, stamped `focus_sessions.metadata.stageOf`. The child-close reactor
 * (`stage-child.ts`) reads it to hand the child's outputs back to that step.
 * A leaf (no imports), so `run-playbook.ts` can stamp it without a cycle.
 */

export const STAGE_OF_METADATA_KEY = "stageOf" as const;

export interface StageOf {
  /** The parent run's session. */
  sessionId: string;
  /** The parent stage that `uses` this run's playbook. */
  stageKey: string;
  /** The parent's `session_stage_runs` row for that entry of the step. */
  stageRunId: string;
}

/** The stamp on a session's metadata, or null (not a child run, or malformed). */
export function readStageOf(metadata: unknown): StageOf | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[
    STAGE_OF_METADATA_KEY
  ] as Partial<StageOf> | undefined;
  if (
    !raw ||
    typeof raw.sessionId !== "string" ||
    typeof raw.stageKey !== "string" ||
    typeof raw.stageRunId !== "string"
  ) {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    stageKey: raw.stageKey,
    stageRunId: raw.stageRunId,
  };
}
