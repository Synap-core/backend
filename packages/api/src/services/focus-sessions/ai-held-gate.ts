/**
 * A CHECK GATE HELD BECAUSE AI WAS NOT AVAILABLE GRADES AGAIN WHEN IT IS BACK.
 *
 * A check gate whose AI judge could not run because AI was not available
 * (credits, plan, payment, provider, service) holds the session with
 * `until: ai:available` (`checkGatePause`, stage-gate.ts). When the pod's pull
 * sees AI come back, the hold-resume worker (@synap/jobs) calls this through
 * its `registerAiHeldGateRegrader` slot. Un-pausing alone would walk a gate
 * whose check never passed, so the stage is GRADED again, as the advance
 * grades it:
 *   - it passes: the gate's own release (`resumeCheckGateIfMet`), the run
 *     moves on by itself;
 *   - the judge still cannot run because AI is out: the session stays held,
 *     exactly as it was (no move, no new hold);
 *   - the judge ran and the check does not pass, or the judge failed for
 *     another reason: the wait on AI is over, so the hold becomes the check's
 *     own (resumed, then held again by `checkGatePause`: the record says why),
 *     and a real fail goes back to the stage's `onFail` as a fresh fail does
 *     (`returnToOnFailStage`). A judge that failed for another reason keeps
 *     holding for the owner's grade (founder decision 8, 20 Nov 2026).
 */
import { and, db, eq, focusSessions, setSessionStatus } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import { checkGatePause, sessionGateSubject } from "../playbooks/stage-gate.js";
import { returnToOnFailStage } from "./advance-stage.js";
import {
  heldByCheckGate,
  resumeCheckGateIfMet,
} from "./evaluations/evaluate.js";

const logger = createLogger({ module: "focus-sessions/ai-held-gate" });

export async function regradeAiHeldGate(params: {
  sessionId: string;
  userId: string;
}): Promise<"not_gate" | "passed" | "held"> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, params.sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  const gate = (session?.metadata as Record<string, unknown> | null)?.[
    CHECK_GATE_METADATA_KEY
  ] as { fromStage?: unknown; stageKey?: unknown } | undefined;
  if (
    !session ||
    session.status !== "paused" ||
    typeof gate?.fromStage !== "string" ||
    typeof gate.stageKey !== "string" ||
    !(await heldByCheckGate(session.id, gate.stageKey))
  ) {
    return "not_gate";
  }
  const { stageKey, fromStage } = gate as {
    stageKey: string;
    fromStage: string;
  };
  const subject = sessionGateSubject({
    sessionId: session.id,
    userId: params.userId,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    channelId: session.channelId,
    playbookId: session.playbookId,
    subjectEntityId: session.subjectEntityId,
    toStage: stageKey,
    fromStage,
  });
  const measure = await subject.checkFailing(fromStage);
  if (measure.failing.length === 0) {
    return (await resumeCheckGateIfMet({
      sessionId: session.id,
      userId: params.userId,
    }))
      ? "passed"
      : "held";
  }
  if (measure.notJudged && measure.aiUnavailable) return "held";

  // The wait on AI is over: the check's own hold replaces it.
  const { rows } = await setSessionStatus(db, {
    sessionId: session.id,
    from: "paused",
    to: "active",
    actor: { kind: "system", userId: params.userId },
    reason: "AI is available again: its check was graded again.",
    set: { updatedAt: new Date() },
  });
  if (rows.length === 0) return "held";
  const { hold, metadataPatch } = checkGatePause(stageKey, fromStage, measure);
  await subject.pause(hold, metadataPatch);
  if (!measure.notJudged) {
    const back = await returnToOnFailStage({
      session: {
        id: session.id,
        currentStage: session.currentStage,
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        channelId: session.channelId,
        playbookId: session.playbookId,
        subjectEntityId: session.subjectEntityId,
      },
      toStage: stageKey,
      userId: params.userId,
      stageWrite: "door",
      fromStage,
    });
    if (back) {
      logger.info(
        { sessionId: session.id, toStage: back },
        "AI is back and the held check does not pass: back to its onFail stage"
      );
    }
  }
  return "held";
}
