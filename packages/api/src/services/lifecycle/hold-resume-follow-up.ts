/**
 * What a HOLD RESUME owes after the move (status-flow W4) — the follow-ups the
 * api's own doors run after the same move, which the resume job in
 * @synap/jobs cannot import (`@synap/api` depends on it). apps/api registers
 * this into the job's slot at boot (`registerHoldResumeFollowUp`):
 *  - a goal: its judgement notices refresh, as `applyTrackStatus` does;
 *  - a session resumed from `stale`: its stale playbook runs go back to
 *    running, as `reviveStaleSession` does;
 *  - a session whose step waited on tools: the step is checked again
 *    (`recheckStageTools`, the stage runner);
 *  - a session whose hold ASKED to wake on its resume (`hold.wake`): the agent
 *    working it is woken once, told why it resumed and what it waited on
 *    (`wakeSessionHolder`). A hold without it wakes nobody, as before.
 */
import type { RecordedHold } from "@synap-core/types/lifecycle";
import { createLogger } from "@synap-core/core";
import { refreshGoalJudgements } from "../tracks/goal-review-notice.js";
import { reviveStaleRuns } from "../focus-sessions/revive-stale-session.js";
import {
  wakeSessionHolder,
  type WakeSessionHolderResult,
} from "../focus-sessions/wake-session-holder.js";

const logger = createLogger({ module: "hold-resume-follow-up" });

export async function holdResumeFollowUp(resumed: {
  subjectType: string;
  subjectId: string;
  from: string;
  /** The hold that resumed (`wake` included), as recorded when it paused. */
  hold?: RecordedHold | null;
  /** The transition that recorded that hold: the wake's operation key. */
  holdTransitionId?: string | null;
  /** Why it resumed (what moved), as the resume move records it. */
  reason?: string | null;
}): Promise<void> {
  try {
    if (resumed.subjectType === "track") {
      await refreshGoalJudgements(resumed.subjectId);
    } else if (
      resumed.subjectType === "focus_session" &&
      resumed.from === "stale"
    ) {
      await reviveStaleRuns(resumed.subjectId);
    }
    // A session whose step waited on tools (its install request was answered):
    // the step is checked again (`recheckStageTools`, never throws).
    if (resumed.subjectType === "focus_session") {
      const { recheckStageTools } =
        await import("../playbooks/stage-runner.js");
      await recheckStageTools(resumed.subjectId);
    }
  } finally {
    // Last, so the agent wakes to a session whose runs and step are already
    // back; and in `finally`, because the resume has already happened: a
    // follow-up above that throws makes the job retry, and the retry finds
    // nothing held, so a wake skipped here would be lost for good. The wake
    // itself never throws (`wakeHolderOnResume`); the error above still does.
    if (
      resumed.subjectType === "focus_session" &&
      resumed.hold?.wake === true
    ) {
      await wakeHolderOnResume({
        sessionId: resumed.subjectId,
        hold: resumed.hold,
        holdTransitionId: resumed.holdTransitionId ?? null,
        reason: resumed.reason ?? null,
      });
    }
  }
}

/** What the pauser said it waited on, as one line of data for the woken agent. */
function waitedOnLine(hold: RecordedHold): string | null {
  const parts = [
    `waited on: ${hold.on}${hold.ref ? ` (${hold.ref})` : ""}`,
    hold.until && "moves" in hold.until
      ? `until: ${hold.until.moves}${hold.until.to ? ` reaches ${hold.until.to}` : ""}`
      : hold.until && "date" in hold.until
        ? `until: ${hold.until.date}`
        : null,
    hold.reason ? `why: ${hold.reason}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/**
 * Wake the session's holder for a resume its hold asked to wake on. Runs
 * AFTER the resume committed: a wake that fails is logged as an error with
 * its reason (and said in the room by the dispatch door), and never undoes
 * the resume. A wake that throws is the same fact, not swallowed into an
 * empty result: it is logged as a failure and the resume stands.
 */
export async function wakeHolderOnResume(p: {
  sessionId: string;
  hold: RecordedHold;
  holdTransitionId: string | null;
  reason: string | null;
}): Promise<WakeSessionHolderResult> {
  // One resume of one pause: the transition that recorded the hold, else the
  // pause's own start (a hold recorded once has one `since`).
  const operation = p.holdTransitionId ?? `${p.sessionId}:${p.hold.since}`;
  let result: WakeSessionHolderResult;
  try {
    result = await wakeSessionHolder({
      sessionId: p.sessionId,
      reason: `This session resumed. ${p.reason?.trim() || "What it waited on is over."}`,
      context: waitedOnLine(p.hold),
      idempotencyKey: `hold-resume-wake:${operation}`,
    });
  } catch (err) {
    result = {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const log = {
    sessionId: p.sessionId,
    holdTransitionId: p.holdTransitionId,
    result,
  };
  if (result.status === "failed") {
    logger.error(
      log,
      "hold resume: waking the session's agent FAILED — the resume stands"
    );
  } else {
    logger.info(log, "hold resume: the session's agent wake");
  }
  return result;
}
