/**
 * Approve-executor for `agent/connect` — the approval half of a PENDING agent
 * key minted by `POST /setup/agent` (`requireApproval`), filed by
 * `services/agent-connect.ts`.
 *
 * Approval activates exactly that key with the APPROVED reach: the payload's
 * `requests`, possibly narrowed by `proposals.revise` before approving. They
 * must stay within the frozen `asked` copy — a revise can narrow, never widen
 * (widening is a new connection). The work itself is `approvePendingAgentKey`,
 * the same function the pod-admin approval pages call.
 *
 * IDENTITY: only the human the key acts for, or a pod admin, may approve
 * (FORBIDDEN otherwise). A key already rejected or replaced is a CONFLICT.
 */

import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { auditLog } from "../../../utils/audit-log.js";
import {
  approvePendingAgentKey,
  readAgentConnectPayload,
  requestsWithin,
} from "../../../services/agent-connect.js";

export function registerAgentExecutors(): void {
  registerProposalExecutor({
    key: "agent/connect",
    async execute({ proposal, userId, input, deps }) {
      const payload = readAgentConnectPayload(proposal.data);
      if (!payload || payload.requests.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This connection request cannot be read — run `synap init` again.",
        });
      }
      if (!requestsWithin(payload.requests, payload.asked)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "An approval can only narrow what the agent asked for. To give it more, connect it again.",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const outcome = await approvePendingAgentKey({
        keyId: payload.keyId,
        approverId: userId,
        approvedRequests: payload.requests,
        settleProposal: false,
      });
      if (outcome === "forbidden")
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the person this agent acts for, or a pod admin, can approve it.",
        });
      if (outcome === "not_found")
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This agent's key no longer exists.",
        });
      if (outcome === "rejected" || outcome === "already_active")
        throw new TRPCError({
          code: "CONFLICT",
          message:
            outcome === "rejected"
              ? "This connection was rejected or replaced — run `synap init` again."
              : "This key was already approved.",
        });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      await auditLog({
        subjectType: "agent_user",
        action: "approve",
        phase: "completed",
        subjectId: payload.agentUserId,
        userId,
        workspaceId: null,
        data: {
          keyId: payload.keyId,
          proposalId: input.proposalId,
          requests: payload.requests,
        },
      });

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: payload.keyId,
        effect: {
          applied: "verified",
          rows: 1,
          ids: [payload.keyId],
          subject: "api_keys",
        },
      };
    },
  });
}
