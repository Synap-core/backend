import { TRPCError } from "@trpc/server";
import { db, proposals, eq, getWorkspaceMembership } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the playbook/* approve executors. */
export function registerPlaybookExecutors(): void {
  // ── playbook / create ────────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated playbook RAW create lands here on
  // approval (the promote path emits `playbook/promote` — its own executor
  // below — so this key materializes exactly one shape). Materializes via the
  // SAME playbooksRouter.create the direct path uses — re-run as the APPROVER
  // with NO agentUserId + no source, so the gate auto-grants for the operator.
  // The propose gate widened `data` to the full create input (goalTemplate is
  // required by createInputSchema).
  //
  // targetId NOTE (decision B): playbooksRouter.create does not accept a
  // caller-supplied id (DB-generated) — adoption is a follow-up.
  registerProposalExecutor({
    key: "playbook/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const goalTemplate = innerData.goalTemplate as string | undefined;
      if (!name || !goalTemplate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook proposal is missing name/goalTemplate",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: createCaller mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      const createArgs = {
        name,
        description: innerData.description as string | undefined,
        goalTemplate,
        params: innerData.params as Record<string, unknown>[] | undefined,
        inputStrategy: innerData.inputStrategy as
          Record<string, unknown> | undefined,
        channelSpec: innerData.channelSpec as
          Record<string, unknown> | undefined,
        expectedOutputs: innerData.expectedOutputs as
          Record<string, unknown>[] | undefined,
        stages: innerData.stages as Record<string, unknown>[] | undefined,
        subjectProfile: innerData.subjectProfile as
          Record<string, unknown> | undefined,
        schedule: innerData.schedule,
        // Propose-only governance marker (maintenance playbooks) — read back so
        // an AI-proposed playbook keeps `metadata.governance.forceProposeWrites`
        // when a human approves it.
        metadata: innerData.metadata as Record<string, unknown> | undefined,
        executor: innerData.executor,
        status: innerData.status,
        // The propose gate stores the Layer-2 context skill in `data`; without
        // reading it back here an APPROVED playbook materialized with no context
        // skill at all — i.e. the feature was a no-op on the agent-proposed path,
        // which is exactly the path that needs a generated HOW. Note this
        // re-runs with NO agentUserId, so the skill is born approved: the human
        // approval genuinely covers it, and the executor will inject it.
        contextSkill: innerData.contextSkill as
          { name?: string; body: string } | undefined,
      };
      await playbookCaller.create(
        createArgs as Parameters<typeof playbookCaller.create>[0]
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

  // ── playbook / promote ───────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated session→playbook PROMOTE lands here on
  // approval (the promote gate emits `playbook/promote`, distinct from raw
  // create). Materializes via the SAME playbooksRouter.promote the direct path
  // uses — re-run as the APPROVER with NO agentUserId + no source; promote is a
  // protectedProcedure that loads the session by id and gates on the LOADED
  // session's workspace, so the caller ctx needs only userId. The stored `data`
  // carries { sessionId, name, description } — the rest is snapshotted FROM the
  // session by promoteSessionToPlaybook, so no further widening is needed.
  //
  // targetId NOTE (decision B): promoteSessionToPlaybook mints the playbook id —
  // adoption is a follow-up.
  registerProposalExecutor({
    key: "playbook/promote",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const sessionId = innerData.sessionId as string | undefined;
      if (!sessionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook promote proposal is missing sessionId",
        });
      }

      // Idempotency: promoteSessionToPlaybook mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { playbooksRouter } = await import("../../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
      } as unknown as Context);
      const promoteArgs = {
        sessionId,
        name: innerData.name as string | undefined,
        description: innerData.description as string | undefined,
      };
      await playbookCaller.promote(
        promoteArgs as Parameters<typeof playbookCaller.promote>[0]
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
