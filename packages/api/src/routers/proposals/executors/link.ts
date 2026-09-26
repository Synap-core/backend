import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { unlinkProjectFromWorkspace } from "../../../utils/project-workspace.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * Approve-executor for `link/delete`.
 *
 * The one door that files it today is MCP `synap_project_use_workspace
 * {remove:true}` — removing a project's `uses` INDEX edge to a workspace. The
 * materializer has no link delete (its `materializeLink` is create-only), so
 * without this executor an approved removal would reach the catch-all's honesty
 * gate and throw NOT_IMPLEMENTED.
 *
 * REPLAY, never reconstruct: it calls the same `unlinkProjectFromWorkspace` the
 * direct path calls, re-floored NOW (a proposal can sit for days).
 *
 * WHOSE FLOOR: `proposals.subjectUserId` — the principal the proposal was filed
 * FOR (see `applyApprovedBlockedBy` in `catch-all.ts` for the full argument).
 * Never the approver, never anything in the payload. A row with no subject has
 * no owner to floor on and is refused.
 *
 * Any other link shape is refused: there is no governed door that files one, and
 * a raw edge delete with no endpoint floor is exactly what this must not become.
 */
export function registerLinkExecutors(): void {
  registerProposalExecutor({
    key: "link/delete",
    async execute({ proposal, userId, input, deps }) {
      const refuse = (why: string) =>
        new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Approval for 'link/delete' refused: ${why} Nothing was removed.`,
        });

      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      if (
        inner.linkType !== "uses" ||
        inner.fromType !== "project" ||
        inner.toType !== "workspace" ||
        typeof inner.fromId !== "string" ||
        typeof inner.toId !== "string"
      ) {
        throw refuse(
          "only a project --uses--> workspace edge can be removed by approval."
        );
      }

      // Re-approve guard: dispatch is not status-guarded.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const ownerUserId = proposal.subjectUserId;
      if (!ownerUserId) {
        throw refuse(
          "the proposal records no owner (subject_user_id), so whose project this is cannot be established."
        );
      }

      const result = await unlinkProjectFromWorkspace(db as never, {
        projectId: inner.fromId,
        workspaceId: inner.toId,
        userId: ownerUserId,
      });
      if (!result.unlinked) {
        throw refuse(
          "the project no longer exists or is no longer visible to the proposal's owner."
        );
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
      // `rows` is the DELETE's own RETURNING count: `0` means the edge was
      // already gone, and the receipt says so instead of claiming a removal.
      return {
        success: true,
        effect: { applied: "verified", rows: result.rows, subject: "link" },
      };
    },
  });
}
