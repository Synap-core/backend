/**
 * A STEP ADVANCES BY ITSELF (work model W6, decision D5 a): once every
 * required outcome of the stage a session stands on is met
 * (`readStageOutcomes`, the one reading of a stage's work), the session
 * moves on to the next stage, through THE advance door (`advance-stage.ts`,
 * `stageWrite: "door"`) with a compare-and-set on the stage it read, so a
 * manual advance racing it never jumps two steps. A session a CHECK gate
 * holds is released the same way (`resumeCheckGateIfMet`): the gate reads
 * the same outcomes, so the output that completes the stage it judged
 * releases it, not only a grade.
 *
 * ONE RULE, TWO TRIGGERS. It is the built-in reaction
 * `builtin:stage-met-advances` (`@synap/jobs` reactions): a slot moving to
 * done fires it through the reactions reactor (its guards, its log row), and
 * a grade — not a move — fires the same rule as a fact from the two grade
 * doors ({@link advanceOnGrade}, the merge sweeper's pattern), logged the
 * same way. The person's pause of the rule stops both.
 *
 * NEVER BY ITSELF:
 *   - into a stage whose gate needs a person (`human`, or `awaits` a named
 *     approval), nor out of a stage waiting for a named approval: a person
 *     moves those (D5 a: "except human gates");
 *   - into a move of the subject only a person may make (a status the
 *     process or the lifecycle marks human-only, or one that closes the
 *     thing): the advance moves the subject as the `system`, which no
 *     governance stops, so such a move waits for a person instead;
 *   - out of a legacy dev-approval stamp (`plan_approved`, `deploy_approved`):
 *     not a stage of any process;
 *   - a session that is not `active` (a human gate's hold, a pause, a close),
 *     except the release of a check gate above.
 * One step per trigger: a stage whose work was met before it was entered
 * waits for its next grade or settled outcome.
 *
 * THE CASCADE. The subject move names the session, so an `enters_status`
 * activator it fires counts the session's own automation chain (the trigger
 * matcher's depth floor, MAX_CHAIN_DEPTH): a run started by a run started by
 * an auto-advance stops at that depth. Through the reactor, the move carries
 * the reaction's `cause`, so the rules it fires stop at MAX_REACTION_DEPTH.
 */
import {
  db,
  eq,
  focusSessions,
  recordReactionOutcomes,
  type ReactionLogEntry,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { TransitionCause } from "@synap-core/types/lifecycle";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import {
  readCriteria,
  resolveStageGate,
  stageOnApproved,
} from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import {
  STAGE_MET_REACTION_ID,
  isReactionEnabled,
  reactionReason,
} from "@synap/jobs/utils/reactions.js";
import type { ReactionEffectOutcome } from "@synap/jobs/utils/reaction-effects.js";
import { DEV_GATE_LEGACY_STAGES } from "../proposals/dev-approval.js";
import {
  advanceSessionStage,
  type AdvanceSessionStageInput,
  type AdvanceSessionStageResult,
  type StageAdvanceSession,
} from "./advance-stage.js";
import { readStageOutcomes } from "./stage-outputs-approved.js";
import { readReachedMoveTarget } from "./stage-subject-status.js";

const logger = createLogger({ module: "focus-sessions/advance-if-stage-met" });

/** One step a session would take by itself, read before anything moves. */
export interface StageWorkStep {
  /** `advance`: on to the next stage. `resume`: a check gate releases it. */
  kind: "advance" | "resume";
  session: StageAdvanceSession & { userId: string };
  /** The session's name, for the log row. */
  name: string;
  /** The stage whose work is met (a resume: the stage its gate judged). */
  fromStage: string;
  /** The stage it enters (a resume: the gated stage it already stands on). */
  toStage: string;
  toStageName: string;
  /** The labels of the outcomes that met the stage (the log's why). */
  met: string[];
}

const LEGACY_STAMPS = new Set<string>(Object.values(DEV_GATE_LEGACY_STAGES));

/**
 * The step a session would take by itself now, or null (see the header for
 * every case that holds it). Read only.
 */
export async function planStageWorkStep(
  sessionId: string
): Promise<StageWorkStep | null> {
  const [s] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      title: focusSessions.title,
      goal: focusSessions.goal,
      metadata: focusSessions.metadata,
      currentStage: focusSessions.currentStage,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
      playbookId: focusSessions.playbookId,
      subjectEntityId: focusSessions.subjectEntityId,
      expectedOutputs: focusSessions.expectedOutputs,
      criteria: focusSessions.criteria,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!s?.currentStage || LEGACY_STAMPS.has(s.currentStage)) return null;
  const held = (s.metadata as Record<string, unknown> | null)?.[
    CHECK_GATE_METADATA_KEY
  ] as { fromStage?: unknown; stageKey?: unknown } | undefined;
  const resume =
    s.status === "paused" &&
    typeof held?.fromStage === "string" &&
    held.stageKey === s.currentStage;
  if (s.status !== "active" && !resume) return null;

  const proc = await loadSessionProcess({
    sessionId: s.id,
    playbookId: s.playbookId,
  });
  if (!proc) return null;
  const at = proc.stages.findIndex((x) => x?.key === s.currentStage);
  if (at < 0) return null;
  const judged = resume ? (held!.fromStage as string) : s.currentStage;
  const here = resume ? proc.stages[at] : proc.stages[at + 1];
  const left = proc.stages.find((x) => x?.key === judged);
  if (!here?.key || !left) return null;
  if (!resume) {
    if (resolveStageGate(left)?.kind === "awaits") return null;
    const gate = resolveStageGate(here);
    if (gate && gate.kind !== "check") return null;
  }

  const criteria = readCriteria(s.criteria);
  const { listSessionEvaluations } = await import("./evaluations/record.js");
  const stage = readStageOutcomes(proc.stages, judged, {
    expectedOutputs: s.expectedOutputs,
    criteria,
    evaluations:
      criteria.length > 0
        ? await listSessionEvaluations({ sessionId: s.id, userId: s.userId })
        : [],
  });
  // A resume needs nothing held (the gate's own rule); an advance needs the
  // stage's work met (a stage with no outcome never advances by itself).
  if (resume ? stage.unmet.length > 0 : !stage.met) return null;

  // The subject moves this step makes: the entered stage's status, and a
  // check gate's reach of the judged stage's `onApproved` first.
  const checked = resume || resolveStageGate(here)?.kind === "check";
  const moves = [
    typeof here.subjectStatus === "string" ? here.subjectStatus.trim() : "",
    checked ? (stageOnApproved(left) ?? "") : "",
  ].filter((v) => v.length > 0);
  for (const value of moves) {
    if (proc.humanOnlyStatuses.includes(value)) return null;
    if (!s.subjectEntityId) continue;
    const target = await readReachedMoveTarget({
      session: s,
      subjectEntityId: s.subjectEntityId,
      value,
    });
    if (
      target &&
      target.current !== value &&
      (target.humanOnly ||
        target.category === "done" ||
        target.category === "lost")
    ) {
      return null;
    }
  }

  return {
    kind: resume ? "resume" : "advance",
    session: {
      id: s.id,
      userId: s.userId,
      currentStage: s.currentStage,
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      channelId: s.channelId,
      playbookId: s.playbookId,
      subjectEntityId: s.subjectEntityId,
    },
    name: s.title?.trim() || (s.goal.split("\n")[0] ?? "").slice(0, 120),
    fromStage: judged,
    toStage: here.key,
    toStageName: here.name ?? here.key,
    met: stage.outcomes.filter((o) => o.met).map((o) => o.label),
  };
}

/** The advance door's input for a planned step: the system's, compare-and-set. */
export function stageMetAdvanceInput(
  step: StageWorkStep,
  cause: TransitionCause | null
): AdvanceSessionStageInput {
  return {
    session: step.session,
    toStage: step.toStage,
    userId: step.session.userId,
    agentUserId: null,
    stageWrite: "door",
    expectedStage: step.fromStage,
    bySystem: { cause },
  };
}

/** What the door did, in the reactor's words. */
export function stageMetAdvanceOutcome(
  r: AdvanceSessionStageResult
): ReactionEffectOutcome {
  if (r.stale) {
    return {
      status: "moved_meanwhile",
      detail: `stage "${r.stale.expectedStage ?? "none"}" is now "${r.stale.currentStage ?? "none"}"`,
    };
  }
  if (r.refused) return { status: "refused", detail: r.refused.reason };
  if (!r.changed) return { status: "unchanged" };
  return { status: "applied", transitionIds: [] };
}

/** A check gate's release, in the reactor's words. */
export function stageMetResumeOutcome(resumed: boolean): ReactionEffectOutcome {
  return resumed
    ? { status: "applied", transitionIds: [] }
    : { status: "unchanged" };
}

/** The log row's sentence: who moved (the rule), and why (what was met). */
export function stageMetSay(step: StageWorkStep): {
  name: string;
  applied: string;
} {
  const met = step.met.map((l) => `“${l}”`).join(", ");
  const what = met || "its work";
  return {
    name: step.name,
    applied:
      step.kind === "resume"
        ? `Let “${step.name}” go on at ${step.toStageName}: ${what} met.`
        : `Moved “${step.name}” on to ${step.toStageName}: ${what} met.`,
  };
}

/**
 * A GRADE fired the rule (a pass recorded by an evaluation or by the person,
 * the check gate's own release already tried): take the step if the stage is
 * now met, and log it as the rule's row, with the grade as its source. Never
 * throws — the grade stands either way.
 */
export async function advanceOnGrade(input: {
  sessionId: string;
  /** The criterion just graded, for the log row's source. */
  criterionKey?: string | null;
}): Promise<boolean> {
  try {
    if (!(await isReactionEnabled(STAGE_MET_REACTION_ID))) return false;
    const step = await planStageWorkStep(input.sessionId);
    if (!step || step.kind !== "advance") return false;
    const out = stageMetAdvanceOutcome(
      await advanceSessionStage(stageMetAdvanceInput(step, null))
    );
    if (out.status === "unchanged" || out.status === "proposed") return false;
    const say = stageMetSay(step);
    const applied = out.status === "applied";
    const row: ReactionLogEntry = {
      reactionId: STAGE_MET_REACTION_ID,
      outcome: applied ? "applied" : "skipped",
      code: out.status,
      ...(out.status === "applied"
        ? {
            reason: say.applied,
            detail: `${step.fromStage} -> ${step.toStage}`,
          }
        : {
            reason: reactionReason(out.status, say.name),
            detail: out.detail,
          }),
      userId: step.session.userId,
      sourceTransitionId: null,
      source: `grade:${step.session.id}/${input.criterionKey ?? "*"}`,
      target: `focus_session:${step.session.id}`,
      to: step.toStage,
      chainId: null,
      depth: null,
      sessionId: step.session.id,
      workspaceId: step.session.workspaceId,
    };
    await recordReactionOutcomes(db, [row]);
    return applied;
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      "the step did not advance after a grade — the grade stands"
    );
    return false;
  }
}
