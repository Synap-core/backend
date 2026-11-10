/**
 * `focus_session/playbook.stage_gate` — approving a playbook stage gate.
 *
 * The whole executor: flip the paused session back to `active`. That is the
 * entire contract, and it is deliberately this small.
 *
 * ── APPROVAL RESUMES, IT NEVER RUNS ─────────────────────────────────────────
 * Same rule as the two dev-loop gates. This executor does not invoke the
 * stage's `grants`, does not dispatch `suggestedTasks`, does not call an agent
 * and does not touch `currentStage` — the stage already stands (the gate was
 * filed AFTER the advance landed; see services/playbooks/stage-gate.ts). An
 * executor that "ran the stage" would put playbook-authored content on the
 * execution path of a reviewer's tap. The agent watching the session sees
 * `active` and acts under its own credentials.
 *
 * REJECTION is deliberately not handled here: rejecting leaves the session
 * paused, which is already true. There is no honest rewind — nothing records
 * what the previous stage's state was — so a reject executor would have to
 * invent one. A stage that DECLARES where a rejection goes (`onFail.toStage`)
 * is returned there by the process engine off the `proposal.rejected` event
 * (`@synap/jobs` `utils/process-sync.ts`) — declared, not invented.
 *
 * APPROVAL also writes the stage's `subjectStatus` onto the run's subject
 * (`writeStageSubjectStatus`) — the advance door holds that write while the
 * gate is open, because entering the stage was not agreed yet.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  focusSessions,
  eq,
  setSessionStatus,
  transitionProposal,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { isTerminalSessionStatus } from "@synap-core/types/focus-sessions";
import {
  registerProposalExecutor,
  type ProposalEffect,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the playbook stage-gate approve executor. */
export function registerPlaybookStageGateExecutors(): void {
  registerProposalExecutor({
    key: "focus_session/playbook.stage_gate",
    async execute({ proposal, userId, input, deps }) {
      const sessionId = proposal.targetId;
      if (!sessionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stage-gate proposal is missing its session target",
        });
      }

      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "Stage-gate proposal targets a session that no longer exists",
        });
      }

      // A gate on a run that ENDED is never approvable into nothing. A session
      // that ends expires its pending gates (`setSessionStatus`), so this is a
      // gate left from before that rule, or a race with the close: refuse,
      // naming why, instead of an approval that changes nothing (live: 9c527c67
      // approved on closed run be143ceb, 9 Nov 2026). More work is a new run.
      if (isTerminalSessionStatus(session.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `This run ended (${session.status}) before its stage gate was answered, ` +
            "so approving it cannot continue it. Nothing was changed. " +
            "Start the playbook again on the same record to go on.",
        });
      }

      // Resume ONLY from a pause (`paused`, or `stale`: the reaper's aging of a
      // pause, still waiting on this gate). A session the human has since
      // closed, failed or cancelled is refused above: an approval about a
      // stage boundary never reanimates a session's life. The guard is in the
      // WHERE clause so the decision and the write cannot disagree.
      // The approver resumes it; the transition names the proposal.
      const { rows: resumed } = await setSessionStatus(db, {
        sessionId,
        from: ["paused", "stale"],
        to: "active",
        actor: { kind: "human", userId },
        proposalId: proposal.id,
        set: { updatedAt: new Date() },
      });

      // THE EFFECT RECEIPT — what Postgres returned for THIS statement, not
      // "we reached this line". Zero rows is a real, reachable outcome (the
      // session was closed, or a concurrent approve already resumed it), and
      // reporting `verified` there would be an approval claiming a write it
      // never made.
      const effect: ProposalEffect =
        resumed.length > 0
          ? {
              applied: "verified",
              rows: resumed.length,
              ids: resumed.map((r) => r.id),
              subject: "focus_session",
            }
          : {
              applied: "none",
              reason:
                "Session was not paused at approval time — it had already been " +
                "resumed, closed or cancelled. The gate is answered; the session " +
                "keeps the state its owner left it in.",
            };

      // The person agreed to the stage: its `subjectStatus` (if any) is written
      // NOW — the advance door skipped it while the gate held. As the approver,
      // through the governed entity door; a skip/failure never un-approves.
      // Only while the run still stands on the GATED stage: a run that moved on
      // since (a follow, a manual advance) must not get the old stage's value.
      const gatedStage = (proposal.data as { stageKey?: unknown } | null)
        ?.stageKey;
      if (
        resumed.length > 0 &&
        session.currentStage &&
        (typeof gatedStage !== "string" || gatedStage === session.currentStage)
      ) {
        const { writeStageSubjectStatus } =
          await import("../../../services/focus-sessions/stage-subject-status.js");
        await writeStageSubjectStatus({
          session,
          toStage: session.currentStage,
          userId,
        });
      }

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );

      return { success: true, effect };
    },
  });
}
