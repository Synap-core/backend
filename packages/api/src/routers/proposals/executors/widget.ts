import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";

/**
 * Approve-executors for `widget` doors.
 *
 * `widget/register` was the sharpest case in the severed-door audit: its gate
 * stored `rendererSourceLength` — the CHARACTER COUNT of agent-authored render
 * code, never the code. A reviewer was asked to approve something they could
 * not read, and approving it could not have registered a widget even if they
 * had. The payload now carries `rendererSource` itself; this is the other half.
 *
 * REPLAY, never reconstruct: `upsertWidgetDef` is an UPSERT
 * (`insert(...).onConflictDoUpdate(...)`, `hub-protocol/widget-definitions.ts`).
 * Re-implementing it here as a plain insert would fail on the second
 * registration of the same `typeKey` instead of updating it — and re-authoring
 * the conflict target is exactly how two writers drift apart.
 */
export function registerWidgetExecutors(): void {
  registerProposalExecutor({
    key: "widget/register",
    async execute({ proposal, userId, input, deps }) {
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

      // Workspace lens from the STORED payload, never a request-supplied field.
      const wsLens =
        (inner.workspaceId as string | null | undefined) ??
        proposal.workspaceId ??
        undefined;

      const { hubWidgetDefinitionsRouter } =
        await import("../../hub-protocol/widget-definitions.js");
      const caller = hubWidgetDefinitionsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: wsLens ?? undefined,
        // `upsertWidgetDef` is a scopedProcedure(["hub-protocol.write"]). The
        // authorization already happened — at the gate when the proposal was
        // filed, and again when this human approved it — so the replay context
        // carries the scope the procedure checks for.
        scopes: ["hub-protocol.write", "hub-protocol.read"],
      } as unknown as Context);

      assertApplied(
        (await caller.upsertWidgetDef({
          ...(inner as Record<string, unknown>),
          userId,
          typeKey,
        } as unknown as Parameters<typeof caller.upsertWidgetDef>[0])) as {
          status?: string;
        }
      );

      reportApproved(deps, proposal, input.proposalId);
      return { success: true };
    },
  });
}
