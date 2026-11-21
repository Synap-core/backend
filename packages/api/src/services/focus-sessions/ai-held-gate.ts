/**
 * A CHECK GATE WHOSE AI JUDGE COULD NOT RUN GRADES AGAIN WHEN ITS HOLD COMES DUE.
 *
 * A check gate whose AI judge could not run holds the session
 * (`checkGatePause`, stage-gate.ts): until AI is back for a payer state
 * (`until: ai:available`), else until a retry date. When that hold comes due
 * (the pod's pull reads AI available, or the hourly sweep reaches the date),
 * the hold-resume worker (@synap/jobs) calls this through its
 * `registerAiHeldGateRegrader` slot. Un-pausing alone would walk a gate whose
 * check never passed, so the stage is GRADED again, as the advance grades it:
 *   - it passes: the gate's own release (`resumeCheckGateIfMet`), the run
 *     moves on by itself;
 *   - the judge still cannot run, for the same kind of wait: the session
 *     stays held exactly as it was (no move, no new hold). A dated one is
 *     tried again by the next sweep; an AI one by the worker's next wake;
 *   - otherwise the hold is REPLACED by the one this grade calls for, in one
 *     transaction (resumed, then held again by `checkGatePause`: the record
 *     says why), and a real fail goes back to the stage's `onFail` as a fresh
 *     fail does (`returnToOnFailStage`). A judge that failed for another
 *     reason keeps holding for the owner's grade, with a dated retry
 *     (founder decision 8, 20 Nov 2026).
 */
import { and, db, eq, focusSessions, setSessionStatus } from "@synap/database";
import type { Hold } from "@synap-core/types/lifecycle";
import { createLogger } from "@synap-core/core";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import {
  checkGatePause,
  pauseSessionAtGate,
  sessionGateSubject,
} from "../playbooks/stage-gate.js";
import { returnToOnFailStage } from "./advance-stage.js";
import {
  heldByCheckGate,
  resumeCheckGateIfMet,
} from "./evaluations/evaluate.js";

const logger = createLogger({ module: "focus-sessions/ai-held-gate" });

/** The kind of wait a hold's `until` names: AI coming back, a date, or none. */
function waitOf(until: Hold["until"] | undefined): "ai" | "date" | "none" {
  if (!until) return "none";
  return "date" in until ? "date" : "ai";
}

export async function regradeAiHeldGate(params: {
  sessionId: string;
  userId: string;
  /** What the hold that came due waited on (absent: unknown, replaced). */
  until?: Hold["until"];
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
  const { hold, metadataPatch } = checkGatePause(stageKey, fromStage, measure);
  if (
    measure.notJudged &&
    params.until !== undefined &&
    waitOf(params.until) === waitOf(hold.until)
  ) {
    return "held";
  }

  // The hold this grade calls for replaces the one that came due, in ONE
  // transaction: never a session left active at a gate that did not pass.
  const replaced = await db.transaction(async (tx) => {
    const { rows } = await setSessionStatus(tx, {
      sessionId: session.id,
      from: "paused",
      to: "active",
      actor: { kind: "system", userId: params.userId },
      reason: "Its check was graded again.",
      set: { updatedAt: new Date() },
    });
    if (rows.length === 0) return false;
    if (
      !(await pauseSessionAtGate(
        tx,
        { sessionId: session.id, userId: params.userId },
        hold,
        metadataPatch
      ))
    ) {
      throw new Error("The re-graded check gate could not hold the session.");
    }
    return true;
  });
  if (!replaced) return "held";
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
        "The held check was graded again and does not pass: back to its onFail stage"
      );
    }
  }
  return "held";
}
