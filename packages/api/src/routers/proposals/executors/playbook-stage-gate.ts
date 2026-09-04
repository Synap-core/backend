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
 * invent one.
 */

import { TRPCError } from "@trpc/server";
import { db, proposals, focusSessions, eq, and } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
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

      // Resume ONLY from `paused`. A session the human has since closed, failed
      // or cancelled must not be reanimated by an approval that was about a
      // stage boundary, not about the session's life. The guard is in the WHERE
      // clause so the decision and the write cannot disagree.
      const resumed = await db
        .update(focusSessions)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(focusSessions.id, sessionId),
            eq(focusSessions.status, "paused")
          )
        )
        .returning({ id: focusSessions.id, status: focusSessions.status });

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

      if (resumed.length > 0) {
        emitHubRealtimeEvent({
          eventType: "focus_session.update.completed",
          subjectId: sessionId,
          userId,
          data: {
            id: sessionId,
            workspaceId: session.workspaceId,
            status: "active",
            goal: session.goal,
            progress: session.progress,
          },
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

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
