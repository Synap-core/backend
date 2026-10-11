/**
 * Approve-executors for the agent doors.
 *
 * `agent/connect` —  — the approval half of a PENDING agent
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
 *
 * `agent/updateCapabilities` — an edit of an agent's limits that the gate
 * turned into a proposal (`agentUsers.update`, ADMIN-floored). Approval sets
 * the proposed capabilities and re-grants the agent's live keys
 * (`applyAgentCapabilities`). Only the agent's person or a pod admin may
 * approve; patterns that do not parse, or a list past one grant, are refused.
 */

import { TRPCError } from "@trpc/server";
import { and, db, proposals, eq } from "@synap/database";
import { ProposalStatus, users } from "@synap/database/schema";
import {
  InvalidPermissionError,
  MAX_GRANT_PERMISSIONS,
  agentKeyGrantPermissions,
  parsePermission,
} from "@synap-core/types/grants";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { auditLog } from "../../../utils/audit-log.js";
import {
  approvePendingAgentKey,
  canDecidePendingConnection,
  readAgentConnectPayload,
  requestsWithin,
} from "../../../services/agent-connect.js";
import { applyAgentCapabilities } from "../../../services/agent-identity-service.js";

/** `{ agentUserId, capabilities }`, flat or under `data`; null if unreadable. */
function readCapabilitiesPayload(
  raw: unknown
): { agentUserId: string; capabilities: string[] } | null {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const d = (
    outer.agentUserId === undefined && outer.data ? outer.data : outer
  ) as Record<string, unknown>;
  if (typeof d.agentUserId !== "string" || !Array.isArray(d.capabilities))
    return null;
  if (!d.capabilities.every((c): c is string => typeof c === "string"))
    return null;
  return { agentUserId: d.agentUserId, capabilities: d.capabilities };
}

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

  registerProposalExecutor({
    key: "agent/updateCapabilities",
    async execute({ proposal, userId, input, deps }) {
      const payload = readCapabilitiesPayload(proposal.data);
      if (!payload)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This change to an agent's limits cannot be read.",
        });
      try {
        for (const c of payload.capabilities)
          if (c.trim() !== "*.*") parsePermission(c);
      } catch (err) {
        if (err instanceof InvalidPermissionError)
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
      if (
        agentKeyGrantPermissions(payload.capabilities).permissions.length >
        MAX_GRANT_PERMISSIONS
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `An agent holds at most ${MAX_GRANT_PERMISSIONS} permissions.`,
        });

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [agent] = await db
        .select({ createdByUserId: users.createdByUserId })
        .from(users)
        .where(
          and(eq(users.id, payload.agentUserId), eq(users.userType, "agent"))
        )
        .limit(1);
      if (!agent)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This agent no longer exists.",
        });
      if (!(await canDecidePendingConnection(userId, agent.createdByUserId)))
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the person this agent belongs to, or a pod admin, can change its limits.",
        });

      const keys = await applyAgentCapabilities({
        agentUserId: payload.agentUserId,
        capabilities: payload.capabilities,
        actorId: userId,
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
        action: "update",
        phase: "completed",
        subjectId: payload.agentUserId,
        userId,
        workspaceId: proposal.workspaceId ?? null,
        data: {
          proposalId: input.proposalId,
          capabilities: payload.capabilities,
          keysRegranted: keys,
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
        primaryId: payload.agentUserId,
        effect: {
          applied: "verified",
          rows: 1,
          ids: [payload.agentUserId],
          subject: "users",
        },
      };
    },
  });
}
