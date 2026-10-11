import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { moveStatus } from "../../../services/lifecycle/move-status.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * Approval half of the `moveStatus` door (work model L2): `entity/transition`.
 *
 * REPLAY, never reconstruct: the SAME door, with governance already decided
 * (`approvedProposalId`) and the agent's ORIGINAL belief as `expectedFrom`.
 * Strict compare-and-set — if a person moved the thing since the proposal was
 * filed, the approval fails as STALE (CONFLICT) and nothing is overwritten:
 * a human move wins.
 */
export function registerEntityTransitionExecutors(): void {
  registerProposalExecutor({
    key: "entity/transition",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (
        raw.data && typeof raw.data === "object" ? raw.data : raw
      ) as Record<string, unknown>;
      const entityId =
        typeof inner.entityId === "string" ? inner.entityId : undefined;
      const to = typeof inner.to === "string" ? inner.to : undefined;
      if (!entityId || !to) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Status-move proposal names no entity or no target status. Nothing was changed.",
        });
      }

      const [current] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (current?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const agentUserId = proposal.agentUserId ?? null;
      const result = await moveStatus({
        entityId,
        role: typeof inner.role === "string" ? inner.role : null,
        facetId: typeof inner.facetId === "string" ? inner.facetId : null,
        expectedFrom:
          typeof inner.expectedFrom === "string" ? inner.expectedFrom : null,
        to,
        actor: agentUserId
          ? {
              kind: "agent",
              userId: proposal.subjectUserId ?? userId,
              agentUserId,
            }
          : { kind: "human", userId },
        reason: typeof inner.reason === "string" ? inner.reason : null,
        workspaceId: proposal.workspaceId ?? null,
        approvedProposalId: input.proposalId,
      });

      if (result.status === "conflict") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Stale: the status moved meanwhile (expected "${result.expectedFrom ?? "none"}", now "${result.actual ?? "none"}"). Nothing was changed.`,
        });
      }
      if (result.status === "refused" || result.status === "denied") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${result.reason} Nothing was changed.`,
        });
      }
      if (result.status === "proposed") {
        // Unreachable: an approved replay skips governance.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "An approved status move was proposed again.",
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
      return {
        success: true,
        primaryId: entityId,
        effect: {
          applied: "verified",
          rows: result.status === "moved" ? 1 : 0,
          ids: result.status === "moved" ? [entityId] : [],
          subject: "entities",
        },
      };
    },
  });
}
