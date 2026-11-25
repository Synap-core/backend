import { TRPCError } from "@trpc/server";
import { db, proposals, eq, transitionProposal } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved, storedProposalFields } from "./shared.js";
import { applyApprovedSurfaceLink } from "../../../services/surfaces/attach.js";
import { applyCreateSurface } from "../../../services/surfaces/create.js";

/**
 * Approve-executors for an ATTACHED surface (Surfaces wave P3):
 * `surface/create` (a body made for an object, and its `attaches` edge),
 * `surface/attach` and `surface/detach` (the edge alone).
 *
 * REPLAY, never reconstruct: each runs the same service the direct path runs
 * (`services/surfaces/attach.ts`, `create.ts`), re-floored NOW as the
 * proposal's OWNER (`proposals.subjectUserId` — never the approver, never the
 * payload; see `applyApprovedBlockedBy` in `catch-all.ts` for why). A refusal
 * writes nothing and says why.
 */
export function registerSurfaceExecutors(): void {
  for (const action of ["attach", "detach", "create"] as const) {
    const key = `surface/${action}` as const;
    registerProposalExecutor({
      key,
      async execute({ proposal, userId, input, deps }) {
        const refuse = (why: string) =>
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Approval for '${key}' refused: ${why} Nothing was changed.`,
          });
        const [settled] = await db
          .select({ status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, input.proposalId));
        if (settled?.status === ProposalStatus.APPROVED) {
          return { success: true, alreadyApproved: true };
        }
        const data = storedProposalFields(proposal);

        let rows: number;
        let primaryId: string | undefined;
        if (action === "create") {
          const made = await applyCreateSurface({
            ownerUserId: proposal.subjectUserId,
            agentUserId: proposal.agentUserId ?? null,
            data,
            proposalId: input.proposalId,
          });
          if (!made.ok) throw refuse(made.why);
          rows = 1;
          primaryId = made.surface.id;
        } else {
          const applied = await applyApprovedSurfaceLink({
            action,
            data,
            ownerUserId: proposal.subjectUserId,
            proposalId: input.proposalId,
          });
          if (!applied.ok) throw refuse(applied.why);
          rows = applied.rows;
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
        return {
          success: true,
          ...(primaryId ? { primaryId } : {}),
          // `rows` is the statement's own count: `0` = already there / gone.
          effect: { applied: "verified" as const, rows, subject: "link" },
        };
      },
    });
  }
}
