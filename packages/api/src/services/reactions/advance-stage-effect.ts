/**
 * The `advance_stage` effect of the reactions reactor — W6's built-in rule
 * `builtin:stage-met-advances` (`@synap/jobs` reactions): a slot moved to
 * done → its session, when every outcome of the stage it stands on is now
 * met → the session moves on to the next stage, through THE advance door
 * (`advanceSessionStage`, `stageWrite: "door"`), as the `system`, with the
 * reaction's `cause`, compare-and-set on the stage the plan read. A session
 * a check gate holds on that stage's work is released instead, through the
 * gate's own release (`resumeCheckGateIfMet`).
 *
 * What holds the step, and why a grade fires the same rule without a move:
 * `focus-sessions/advance-if-stage-met.ts`.
 *
 * Its door lives in @synap/api, so apps/api fills the effect's slot in
 * @synap/jobs at boot (`registerReactionEffect`), like `reach_stage_status`.
 */
import type { ReactionEffect } from "@synap/jobs/utils/reaction-effects.js";
import { advanceSessionStage } from "../focus-sessions/advance-stage.js";
import {
  planStageWorkStep,
  stageMetAdvanceInput,
  stageMetAdvanceOutcome,
  stageMetResumeOutcome,
  stageMetSay,
  type StageWorkStep,
} from "../focus-sessions/advance-if-stage-met.js";
import { resumeCheckGateIfMet } from "../focus-sessions/evaluations/evaluate.js";

export const advanceStageReactionEffect: ReactionEffect = {
  key: "advance_stage",
  async plan(t) {
    if (t.subjectType !== "slot" || !t.sessionId) return [];
    const slotKey = (t as { slotKey?: unknown }).slotKey;
    if (typeof slotKey !== "string" || !slotKey) return [];
    const step = await planStageWorkStep(t.sessionId, { slotKey });
    if (!step) return [];
    return [
      {
        target: { subjectType: "focus_session", subjectId: step.session.id },
        to: step.toStage,
        // A step is work in progress: never a close (D3 does not apply).
        toCategory: "active",
        expectedFrom: step.fromStage,
        ownerUserId: step.session.userId,
        detail: step as unknown as Record<string, unknown>,
        say: stageMetSay(step),
      },
    ];
  },
  async apply(write, ctx) {
    const step = write.detail as unknown as StageWorkStep;
    if (step.kind === "resume") {
      return stageMetResumeOutcome(
        await resumeCheckGateIfMet({
          sessionId: step.session.id,
          userId: step.session.userId,
        })
      );
    }
    return stageMetAdvanceOutcome(
      await advanceSessionStage(stageMetAdvanceInput(step, ctx.cause))
    );
  },
};
