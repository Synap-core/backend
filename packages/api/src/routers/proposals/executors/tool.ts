import { TRPCError } from "@trpc/server";
import { db, proposals, eq, tools } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { registerProposalExecutor } from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import type { Context } from "../../../context.js";

const logger = createLogger({ module: "proposal-approve-executors-tool" });

/** Register the tool/* approve executors. */
export function registerToolExecutors(): void {
  // ── tool / create ────────────────────────────────────────────────────────────
  // A gated tool create (agent-authored, or a member whose role lacks `create`)
  // lands here on approval. WITHOUT this executor the proposal fell through to
  // the `*/*` catch-all, which flips the row APPROVED and emits the audit event
  // but INSERTS NOTHING — the approver was told "approved" and no tool ever
  // existed, with no way to recover the request (the propose payload had been
  // narrowed to {name, kind}). Mirrors `skill/create`: already-approved guard →
  // materialize → seed the enforcement grant.
  //
  // NOT replayed here: `deriveToolVerbs` (create-from-definition.ts:630). Verbs
  // are derived from the CAPABILITY DEFINITION's skill list, which a plain
  // `tools.create` proposal does not carry — a definition-sourced tool gets its
  // verbs on the next capability reconcile. See wave report.
  registerProposalExecutor({
    key: "tool/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const kind = innerData.kind as string | undefined;
      if (!name || !kind) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Tool proposal is missing name/kind",
        });
      }

      // Idempotency: the insert mints a fresh id each run, so a re-approve
      // without this guard would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Workspace lens comes from the STORED proposal data (what was proposed),
      // never from a request-supplied field.
      const wsLens =
        (innerData.workspaceId as string | null | undefined) ??
        proposal.workspaceId ??
        null;

      const [tool] = await db
        .insert(tools)
        .values({
          workspaceId: wsLens,
          // Preserve the AUTHOR (mirrors automation/create): the agent wrote the
          // change, the human only approved it.
          createdBy: proposal.agentUserId ?? userId,
          name,
          kind: kind as (typeof tools.$inferInsert)["kind"],
          description: (innerData.description as string | null) ?? undefined,
          inputSchema:
            (innerData.inputSchema as Record<string, unknown> | null) ?? {},
          credentialRef:
            (innerData.credentialRef as string | null) ?? undefined,
          executor:
            (innerData.executor as (typeof tools.$inferInsert)["executor"]) ??
            "is-agent",
          config: (innerData.config as Record<string, unknown> | null) ?? {},
          metadata:
            (innerData.metadata as Record<string, unknown> | null) ?? {},
        })
        .returning();

      // Seed the enforcement grant — the same conservative policy the
      // definition applier uses on its synchronous `created` branch
      // (create-from-definition.ts:619), which the PROPOSED path skipped.
      // Non-fatal (the verb-replay precedent above): the tool row is already
      // committed, so never break the approval over a grant seed.
      try {
        const { issueCapabilityGrant } =
          await import("../../../services/capabilities/create-from-definition.js");
        await issueCapabilityGrant("tool", tool.id, userId, wsLens);
      } catch (err) {
        logger.error(
          { toolId: tool.id, err },
          "tool/create approval: issueCapabilityGrant failed (non-fatal — approval proceeds)"
        );
      }

      emitSideEffects({
        subjectType: "tool",
        action: "create",
        subjectId: tool.id,
        userId,
        ...(wsLens ? { workspaceId: wsLens } : {}),
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
  // ── tool / delete ────────────────────────────────────────────────────────
  // `tools.delete` (routers/tools.ts:631) sits on the rung-2.5 DESTRUCTIVE
  // floor, which no rung can widen, so an agent deleting a tool ALWAYS
  // proposes — and with no executor, approval fell to the `*​/*` catch-all,
  // which flips the row APPROVED and deletes nothing. Same unrecoverable-
  // approval defect `tool/create` above records, on the destructive side.
  //
  // PAYLOAD: the gate stores FLAT `data: { id }` (nested as `data.data.id`);
  // `proposal.targetId` holds the same id. All three shapes are read.
  //
  // SECOND EFFECT: the direct path is `assertWorkspaceWrite` → `db.delete(tools)`
  // → `auditLog` → `emitSideEffects`. Deleting the row here would skip the
  // reactor bus AND the write floor. Replayed through `toolsRouter.delete`.
  //
  // IDENTITY: acts as the APPROVER — unlike `project/delete` / `skill/delete`,
  // nothing downstream carries an ownership ROW predicate that would 404 the
  // approver; the only gate is `assertWorkspaceWrite` on the loaded row
  // (`{ workspaceId, ownerId: createdBy }`), which is an explicit AUTHORIZATION
  // floor. Replaying as the row's owner would step past it, so the approver
  // must clear it themselves. A pod-wide tool created BY an agent
  // (`tool/create` stamps `createdBy: proposal.agentUserId ?? userId`) is
  // therefore not deletable by a different human here — a loud FORBIDDEN that
  // exactly matches what the direct path does, never a silent no-op.
  registerProposalExecutor({
    key: "tool/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const toolId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!toolId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Tool delete proposal is missing the tool id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const existing = await db.query.tools.findFirst({
        where: eq(tools.id, toolId),
        columns: { id: true, workspaceId: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Tool to delete no longer exists",
        });
      }

      const { toolsRouter } = await import("../../tools.js");
      const toolCaller = toolsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: existing.workspaceId ?? undefined,
      } as unknown as Context);

      // The replay must APPLY, never re-propose — see `assertApplied`.
      assertApplied(await toolCaller.delete({ id: toolId }));

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
