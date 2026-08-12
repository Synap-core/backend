import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the cell/define approve executor. */
export function registerCellExecutors(): void {
  // ── cell / define ────────────────────────────────────────────────────────────
  // A gated `synap_create_cell` (agent-authored AI-generated renderer source —
  // the MCP adapter threads agentUserId into the gate) lands here on approval.
  // Materializes via the SAME `defineCell` door the operator auto-apply path uses,
  // so the widget_definitions upsert + realtime refresh event match exactly.
  // Without this executor the `*/*` catch-all would flip the proposal APPROVED and
  // emit a `cell.define.validated` event that NO worker handles (the materializer
  // `cell` case is `cell.create`/cell-instances only) — the definition would never
  // be written. The distinct action (`cell.define`) keeps it off that path.
  registerProposalExecutor({
    key: "cell/define",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const rendererSource = innerData.rendererSource as string | undefined;
      if (!name || !rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cell proposal is missing name/rendererSource",
        });
      }

      // Idempotency: defineCell upserts, but skip the whole apply once the row
      // has already been flipped APPROVED (double-click / retried re-approve).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { defineCell } =
        await import("../../../services/cells/define-cell.js");
      await defineCell({
        name,
        rendererSource,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ??
          proposal.workspaceId ??
          null,
        description:
          (innerData.description as string | null | undefined) ?? null,
        // View-renderer affinity, carried in the gate `data` by the doors that
        // accept it (Hub `POST /cells/define`, MCP `synap_create_cell`).
        // Absent ⇒ undefined ⇒ defineCell leaves any stored affinity untouched.
        viewTypes: Array.isArray(innerData.viewTypes)
          ? (innerData.viewTypes as string[])
          : undefined,
        userId,
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
