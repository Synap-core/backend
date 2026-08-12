import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { assertApprovalTargetResolves } from "../../../services/capabilities/execute-capability.js";
import { triggerProviderAction } from "../../../connectors/external-dispatch.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
} from "../execution-registry.js";
import { reportApproved, dispatchExternalOnce } from "./shared.js";

const logger = createLogger({ module: "proposal-approve-executors-provider" });

/** Register the provider.action approve executor. */
export function registerProviderExecutors(): void {
  // ── provider.action (proposalType-only) — AGNOSTIC EXTERNAL LAST-MILE ────────
  // Closes North Star gap #1's generic tail: approve a proposal that names an
  // arbitrary provider + HTTP method + path, and dispatch it through the SAME
  // shared `triggerProviderAction()` the `/connectors/tool-execute` endpoint
  // uses (ONE impl, two doors — mirrors sendExternalMessage). `vault://` stays
  // 501 inside the shared helper. Idempotent: skip if already APPROVED.
  registerProposalExecutor({
    key: "provider.action",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
      const provider = data.provider as string | undefined;
      const method = data.method as string | undefined;
      const path = data.path as string | undefined;

      if (!provider || !method || !path) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Provider action requires provider, method, and path in proposal data",
        });
      }

      // Guard: only execute once (external proxy calls are irreversible).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      let providerBody: unknown;
      let providerStatus: unknown;
      await dispatchExternalOnce(input.proposalId, async () => {
        const {
          success: executed,
          body,
          status,
          error: providerError,
          errorClass,
          providerRef,
        } = await triggerProviderAction({
          userId,
          provider,
          method,
          path,
          body: data.body as Record<string, unknown> | undefined,
          accountHint: data.accountHint as string | undefined,
          baseUrlOverride:
            (data.baseUrlOverride as string | undefined) ?? undefined,
          workspaceId: (data.workspaceId as string | undefined) ?? undefined,
          // Governed Door-2 re-entry: a human already approved this proposal, so
          // bypass the capability-execution gate (no re-propose) — exactly once.
          alreadyApproved: true,
          sourceProposalId: input.proposalId,
        });
        if (!executed) {
          logger.warn(
            {
              proposalId: input.proposalId,
              provider,
              method,
              path,
              providerError,
            },
            "provider.action executor failed"
          );
          return {
            delivered: false,
            reason: providerError,
            errorClass,
            providerRef,
          };
        }
        providerBody = body;
        providerStatus = status;
        return { delivered: true };
      });

      const materializedPayload = {
        ...payload,
        providerResult: {
          executedAt: new Date().toISOString(),
          provider,
          method,
          path,
          status: providerStatus,
          result: providerBody,
        },
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
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
