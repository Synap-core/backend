import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import type { Context } from "../../../context.js";

/**
 * Register the role/* approve executors.
 *
 * (`role/delete` is registered in `workspace.ts` alongside the other
 * membership/access doors and is deliberately left where it is — moving it
 * would be an unrelated edit to a file this wave does not otherwise touch.)
 */
export function registerRoleExecutors(): void {
  // ── role / create ─────────────────────────────────────────────────────────
  // A gated role create lands here on approval. Before this executor the
  // proposal fell to the `*​/*` catch-all: the row flipped APPROVED and NO role
  // was ever inserted — and because the gate payload had been narrowed to
  // `{ id, name }`, the request was unrecoverable even by hand. `permissions`
  // is a REQUIRED, non-defaultable input, so the narrow payload could not have
  // materialized a role that grants anything even if an executor had existed.
  //
  // REPLAY, not reconstruct: `rolesRouter.create` runs `roleRepo.create` (which
  // mints the id and writes the event via EventRepository) AND
  // `recordDomainMutation` — the ONE side-effect door. A hand-rolled
  // `db.insert(roles)` here would silently drop both.
  //
  // IDENTITY: replays as the APPROVER. `roleRepo.create` stamps
  // `createdBy: ctx.userId`, so the reviewer owns the row they approved — the
  // same attribution the direct path gives.
  //
  // ⚠️ `data.id` IS stamped by this gate (the procedure mints `randomUUID()`
  // BEFORE the check), but it is deliberately NOT reused: the direct path does
  // not pass it to `roleRepo.create` either, so the repo mints the real id.
  // Threading the gate's id would fork identity between the two paths.
  registerProposalExecutor({
    key: "role/create",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;

      const name = inner.name as string | undefined;
      const permissions = inner.permissions as
        Record<string, unknown> | undefined;
      if (!name || typeof name !== "string" || name.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Role proposal is missing name",
        });
      }
      // A role with no permissions grants nothing. Refuse loudly rather than
      // seating an empty role that looks approved and does nothing — the exact
      // failure mode the payload widening exists to prevent.
      if (!permissions || typeof permissions !== "object") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Role proposal is missing `permissions` — refusing to create a role that grants nothing.",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, and the
      // create mints a fresh id each run, so a re-approve would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Workspace lens from the STORED payload (what was proposed), never a
      // request-supplied field. `undefined` = a pod-wide (global) role.
      const wsLens =
        (inner.workspaceId as string | null | undefined) ??
        proposal.workspaceId ??
        undefined;

      const { rolesRouter } = await import("../../roles.js");
      const caller = rolesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: wsLens ?? undefined,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(
        await caller.create({
          name,
          description: inner.description as string | undefined,
          workspaceId: (wsLens as string | undefined) ?? undefined,
          permissions: permissions as Record<string, unknown>,
          filters: inner.filters as Record<string, unknown> | undefined,
        })
      );

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

  // ── role / update ─────────────────────────────────────────────────────────
  // Before the payload widening this gate stored `{ id }` alone — it described
  // NO CHANGE, so even a correct executor had nothing to apply. It now carries
  // the same patch fields `roleRepo.update` reads.
  //
  // REPLAY: `rolesRouter.update` also re-runs the `assertWorkspaceWrite` floor
  // against the ROLE ROW's real workspace (not the request's), which a direct
  // `db.update(roles)` here would step past. That floor is an AUTHORIZATION
  // check, so the approver must clear it themselves — a loud FORBIDDEN that
  // matches the direct path exactly, never a silent no-op.
  //
  // OMITTED-FIELD FIDELITY: `undefined` keys drop out at JSON serialization, so
  // a field the proposer left alone is still absent here and stays unchanged.
  // Reading them back as `undefined` reproduces that exactly — do NOT coalesce
  // to `null`, which would blank a column the proposal never mentioned.
  registerProposalExecutor({
    key: "role/update",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;
      const roleId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!roleId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Role update proposal is missing the role id",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { rolesRouter } = await import("../../roles.js");
      const caller = rolesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: proposal.workspaceId ?? undefined,
      } as unknown as Context);

      assertApplied(
        await caller.update({
          id: roleId,
          name: inner.name as string | undefined,
          description: inner.description as string | undefined,
          permissions: inner.permissions as Record<string, unknown> | undefined,
          filters: inner.filters as Record<string, unknown> | undefined,
        })
      );

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
