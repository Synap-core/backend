import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the automation/* approve executors. */
export function registerAutomationExecutors(): void {
  // ── automation / create ──────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated automation create (agent-authored —
  // the automations router only gates the `agentUserId` path) lands here on
  // approval. The canonical internal materializer re-validates the stored
  // definition and data contract, preserves the originating agent as creator,
  // and uses the proposal target id as the stable automation id. The propose
  // gate widened `data` to the full create input, so triggerConfig /
  // flowDefinition / status / metadata / state all flow through
  // (flowDefinition is required).
  //
  registerProposalExecutor({
    key: "automation/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const triggerType = innerData.triggerType as string | undefined;
      const flowDefinition = innerData.flowDefinition;
      if (!name || !triggerType || !flowDefinition) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Automation proposal is missing name/triggerType/flowDefinition",
        });
      }

      // Fast retry guard; the stable target id below also closes the concurrent
      // approval race before this status update becomes visible.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const automationAuthorId =
        proposal.agentUserId ?? proposal.createdBy ?? undefined;
      if (!automationAuthorId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Automation proposal is missing its author identity",
        });
      }

      const { materializeApprovedAutomation } =
        await import("../../automations.js");
      await materializeApprovedAutomation({
        database: db,
        agentUserId: automationAuthorId,
        stableId: proposal.targetId,
        definition: {
          workspaceId: proposal.workspaceId ?? undefined,
          name,
          description: innerData.description as string | undefined,
          triggerType: triggerType as "event" | "cron" | "webhook" | "manual",
          triggerConfig:
            (innerData.triggerConfig as Record<string, unknown> | undefined) ??
            {},
          flowDefinition: flowDefinition as {
            nodes: Array<Record<string, unknown>>;
            edges: Array<Record<string, unknown>>;
          },
          status:
            (innerData.status as
              "draft" | "active" | "paused" | "error" | undefined) ?? "draft",
          metadata: innerData.metadata as Record<string, unknown> | undefined,
          state: innerData.state as Record<string, unknown> | undefined,
          source: "ai" as const,
        },
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

  // ── automation / execute ─────────────────────────────────────────────────────
  // A gated manual RUN of an existing automation (`automations.trigger` gates the
  // `agentUserId` path — running a flow is CODE EXECUTION, so `automation.execute`
  // is not auto-approved) lands here on approval.
  //
  // WHY THIS EXECUTOR EXISTS: without it the `*/*` catch-all flips the proposal
  // APPROVED and emits `automation.execute.validated`, but the materializer's
  // subject switch (packages/jobs/src/workers/materializer.ts) has NO `automation`
  // case — the job falls into `default:` ("Unknown subject type for
  // materialization") and returns. So approval was a silent no-op: the user
  // approved a run that never ran. (Contrast `command/execute`, which the
  // catch-all path DOES materialize via `materializeCommand` — that key
  // deliberately has no executor here; see the tests.)
  //
  // Materializes via the SAME automationsRouter.trigger the direct path uses —
  // re-run as the APPROVER with NO agentUserId, which takes the operator branch
  // (assertWorkspaceWrite on the LOADED row, then enqueue; never re-propose).
  //
  // targetId NOTE: the gate `data` carries no `id`/`entityId`/`documentId`, so
  // `proposals.targetId` is a RANDOM uuid for this key — the automation is
  // identified by `data.automationId` only. Never read targetId here.
  registerProposalExecutor({
    key: "automation/execute",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const automationId = innerData.automationId as string | undefined;
      if (!automationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Automation run proposal is missing automationId",
        });
      }

      // Idempotency: trigger enqueues a NEW run each call, so a double-approve
      // would run the flow twice. Skip once the row is already APPROVED.
      // (APPROVAL_FAILED is intentionally NOT skipped — the dispatch site allows
      // re-approve to retry, and a failed trigger never enqueued a run.)
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { automationsRouter } = await import("../../automations.js");
      const automationCaller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
      } as unknown as Context);
      // NO agentUserId — neither in the ctx literal above nor in the input below.
      // `trigger` computes `input.agentUserId ?? ctx.agentUserId ?? undefined`
      // and only calls checkPermissionOrPropose `if (agentUserId)`, so this
      // re-entry CANNOT re-trigger the gate (no proposal loop). RBAC is not
      // skipped: `trigger` still runs assertWorkspaceWrite against the LOADED
      // automation's workspace + owner for the approver.
      //
      // workspaceId is deliberately NOT passed: `trigger` rejects a mismatch
      // with the automation's own workspace, and the proposal's workspace lens
      // need not equal it (pod-wide automations carry a null workspace).
      const result = await automationCaller.trigger({
        id: automationId,
        subjectEntityId: innerData.subjectEntityId as string | undefined,
        payload: innerData.payload as Record<string, unknown> | undefined,
      });

      // Belt-and-braces on the no-re-gate invariant: if `trigger` ever returned
      // "proposed" from here it would mean the approval spawned ANOTHER proposal.
      // Fail loudly (proposal stays un-approved, dispatch site records
      // APPROVAL_FAILED and re-throws to the user) rather than reporting success.
      if (result.status !== "triggered") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Approved automation run did not start (status="${result.status}")`,
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: result.runId ?? undefined };
    },
  });
}
