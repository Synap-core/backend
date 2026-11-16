/**
 * The STEP a child run works (runner engine slice 4, spec 7111934d §3.2): a
 * stage of a parent run that `uses` a playbook starts that playbook as its
 * own run, stamped `focus_sessions.metadata.stageOf` (and so does each child
 * run of a `forEach` step). The child-close reactor
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
  /**
   * A `forEach` step: which of its batches this run works (an index into the
   * row's `fanOut.children`). Absent for a step that `uses` a playbook once.
   */
  forEachIndex?: number;
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
    ...(Number.isInteger(raw.forEachIndex) && raw.forEachIndex! >= 0
      ? { forEachIndex: raw.forEachIndex }
      : {}),
  };
}

/**
 * A playbook reduced to ONE of its stages: what a child run of a `forEach`
 * step that names no `uses` playbook runs (`RunPlaybookInput.stageOnly`).
 * The step keeps its goal, outputs, criteria, runner and tools; it loses what
 * belongs to the parent run (its own fan-out, its entry gate, its failure
 * return, its tie to the subject's status) and so does the playbook (its
 * deliverables and criteria are the parent's; it never fans out by input).
 * The step's goal becomes the run's goal when it has one. Pure; throws when
 * the playbook has no such stage.
 */
export function scopePlaybookToStage<
  P extends {
    name: string;
    goalTemplate: string;
    stages: unknown;
    expectedOutputs: unknown;
    criteria: unknown;
    inputStrategy: unknown;
  },
>(playbook: P, stageKey: string): P {
  const stages = Array.isArray(playbook.stages) ? playbook.stages : [];
  const stage = stages.find(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === "object" && (s as { key?: unknown }).key === stageKey
  );
  if (!stage) {
    throw new Error(`"${playbook.name}" has no step "${stageKey}" to run.`);
  }
  const {
    forEach: _forEach,
    gate: _gate,
    onFail: _onFail,
    subjectStatus: _subjectStatus,
    ...step
  } = stage;
  const goal = typeof step.goal === "string" ? step.goal.trim() : "";
  return {
    ...playbook,
    goalTemplate: goal || playbook.goalTemplate,
    stages: [step],
    expectedOutputs: [],
    criteria: [],
    inputStrategy: { kind: "none" },
  };
}
