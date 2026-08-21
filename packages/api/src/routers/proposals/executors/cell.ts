import { TRPCError } from "@trpc/server";
import { db, proposals, eq, and, cellInstances } from "@synap/database";
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
        // SCOPE = THE REVIEWED SCOPE, never the payload. This used to read
        // `innerData.workspaceId ?? proposal.workspaceId ?? null`, so the
        // caller-supplied gate `data` chose the cell's scope.
        //
        // PRECISION on the reachable vector (measured, not assumed — the first
        // reading of this bug overstated it): `??` falls through on a payload
        // `null`, so a payload could NOT force POD-GLOBAL. What it COULD do is
        // REDIRECT: a payload naming workspace B out-votes a proposal reviewed
        // under workspace A, and a payload workspace NARROWS a pod-wide
        // proposal into one workspace. Both write the cell at a scope no
        // reviewer approved, which is the defect regardless of direction.
        //
        // The two doors that mint these proposals (MCP `synap_create_cell`,
        // Hub `POST /cells/define`) always write the SAME value into both
        // places, so this is a no-op for every legitimate caller today; the
        // divergence appears the moment the two can differ — e.g. `revise`
        // re-targets `proposals.workspaceId` (that path re-authorizes the
        // DESTINATION, and pod-wide requires pod-admin) while leaving the
        // stored `data.workspaceId` untouched, at which point the stale payload
        // would win over the scope a reviewer actually approved.
        // Matches `view/create` (executors/view.ts), which already reads only
        // `proposal.workspaceId ?? null`.
        workspaceId: proposal.workspaceId ?? null,
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

  // ── cell / update ─────────────────────────────────────────────────────────
  // Before the payload widening this gate stored `{ id }` alone — and the whole
  // point of this door is the new `config`, so an approved proposal had nothing
  // to write. It now carries `{ id, config, workspaceId }`.
  //
  // NO PROCEDURE TO REPLAY: unlike `tool/update` or `role/update`, the direct
  // path here is an inline `db.update(cellInstances)` inside the REST handler
  // (`hub-protocol/rest/cell-instances.ts` PATCH), not a tRPC mutation. There is
  // no router door to re-enter, so this MIRRORS that `.set()` exactly — the same
  // shape `tool/create` uses for its inline insert. If that handler ever grows a
  // side effect, it must be added here too; there is no shared door to inherit
  // it from.
  //
  // WORKSPACE: taken from the STORED payload, which the gate recorded as the
  // CONFINED value (never the raw request `body.workspaceId`). The `.where()`
  // below re-applies it as a scope predicate exactly as the direct path does, so
  // an approval can never write a cell outside the workspace that was reviewed.
  registerProposalExecutor({
    key: "cell/update",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;
      const cellId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!cellId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cell update proposal is missing the cell id",
        });
      }
      const config = inner.config as Record<string, unknown> | undefined;
      if (config === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cell update proposal carries no `config` — nothing to apply.",
        });
      }

      const wsLens =
        (inner.workspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!wsLens) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cell update proposal has no workspace scope — refusing an unscoped write.",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch. The update
      // itself is idempotent, but the guard keeps the emit/report half from
      // firing twice.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [row] = await db
        .update(cellInstances)
        .set({ config, updatedAt: new Date() })
        .where(
          and(
            eq(cellInstances.id, cellId),
            eq(cellInstances.workspaceId, wsLens)
          )
        )
        .returning();
      if (!row) {
        // Matches the direct path's own not-found branch. Throwing leaves the
        // proposal PENDING rather than reporting a write that never landed.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cell to update no longer exists in the proposed workspace",
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
      return { success: true };
    },
  });
}
