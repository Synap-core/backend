import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";

/**
 * Approve-executor for the LEGACY `widget/register` key.
 *
 * New Hub widget registrations are filed as `cell/define` (the Hub
 * widget-definitions door goes through `defineCell`, the one writer of
 * `widget_definitions`). This key stays registered so proposals filed before
 * that change can still be approved: it reads the old payload shape and hands
 * it to the same `applyCellDefineProposal` the `cell/define` executor uses, so
 * the rendererType derivation, deps validation and `widget_definition` realtime
 * event are identical. Old rows keep reading as before.
 */
export function registerWidgetExecutors(): void {
  registerProposalExecutor({
    key: "widget/register",
    async execute(ctx) {
      const { proposal, input } = ctx;
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;

      const typeKey = inner.typeKey as string | undefined;
      if (!typeKey || typeof typeKey !== "string" || typeKey.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Widget proposal is missing typeKey",
        });
      }
      // Refuse loudly rather than registering a widget that renders nothing.
      // The gate used to store only the LENGTH of this field; a proposal filed
      // before that fix carries no code at all, and seating it would produce a
      // widget definition that looks approved and cannot render.
      if (typeof inner.rendererSource !== "string" || !inner.rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Widget proposal carries no `rendererSource` — refusing to register a widget that cannot render. Re-file the proposal.",
        });
      }

      // Re-approve guard: dispatch is not status-guarded, and an upsert replay
      // would otherwise re-run on every approval attempt.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Delegate to the ONE cell writer. The scope is the REVIEWED scope
      // (`proposal.workspaceId`), exactly as for `cell/define`; the old replay
      // trusted a payload workspace over it.
      const { applyCellDefineProposal } = await import("./cell.js");
      return applyCellDefineProposal(ctx, inner);
    },
  });
}
