/**
 * What a HOLD RESUME owes after the move (status-flow W4) — the follow-ups the
 * api's own doors run after the same move, which the resume job in
 * @synap/jobs cannot import (`@synap/api` depends on it). apps/api registers
 * this into the job's slot at boot (`registerHoldResumeFollowUp`):
 *  - a goal: its judgement notices refresh, as `applyTrackStatus` does;
 *  - a session resumed from `stale`: its stale playbook runs go back to
 *    running, as `reviveStaleSession` does;
 *  - a session whose step waited on tools: the step is checked again
 *    (`recheckStageTools`, the stage runner).
 */
import { refreshGoalJudgements } from "../tracks/goal-review-notice.js";
import { reviveStaleRuns } from "../focus-sessions/revive-stale-session.js";

export async function holdResumeFollowUp(resumed: {
  subjectType: string;
  subjectId: string;
  from: string;
}): Promise<void> {
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
    const { recheckStageTools } = await import("../playbooks/stage-runner.js");
    await recheckStageTools(resumed.subjectId);
  }
}
