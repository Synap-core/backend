/**
 * `focus_session/orchestrate` — approving "Start an orchestrator" (founder
 * decision D5; `services/focus-sessions/start-orchestrator.ts`). The executor
 * re-reads the proposal's payload and hands it to `applyOrchestration`, the
 * same body a caller the gate granted runs at once: the orchestrator session
 * under the id the proposal named, one `orchestrated_by` link per picked
 * session, each running one paused on the person's yes, one note per room.
 * Rejecting the proposal runs nothing, so nothing is written.
 */
import { TRPCError } from "@trpc/server";
import { db, eq, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

export function registerFocusSessionOrchestrateExecutor(): void {
  registerProposalExecutor({
    key: "focus_session/orchestrate",
    async execute({ proposal, userId, input, deps }) {
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const data = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const orchestratorSessionId = str(data.id) ?? proposal.targetId;
      const brief = str(data.goal);
      const sessionIds = Array.isArray(data.sessionIds)
        ? data.sessionIds.filter((s): s is string => typeof s === "string")
        : [];
      if (!brief || sessionIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Orchestrator proposal ${input.proposalId} names no brief or no sessions`,
        });
      }
      const agentId = str(data.agentId);

      // THE route again, at approval: the agent may have been paused since.
      if (agentId) {
        const { handOffRefusal } =
          await import("../../../services/focus-sessions/agent-hand-off.js");
        const refused = await handOffRefusal({
          ownerId: userId,
          agentId,
          agentName: str(data.agentName),
        });
        if (refused) {
          throw new TRPCError({ code: "BAD_REQUEST", message: refused });
        }
      }

      const { applyOrchestration } =
        await import("../../../services/focus-sessions/start-orchestrator.js");
      const result = await applyOrchestration({
        // The approver: the picked sessions are re-read on THEIR owner floor,
        // so a reviewer who does not own them orchestrates nothing.
        ownerId: userId,
        orchestratorSessionId,
        sessionIds,
        brief,
        title: str(data.title) ?? `Orchestrate ${sessionIds.length} sessions`,
        agentId,
        senderAgentId: agentId ?? proposal.agentUserId ?? null,
        proposalId: input.proposalId,
      });

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, ...result };
    },
  });
}
