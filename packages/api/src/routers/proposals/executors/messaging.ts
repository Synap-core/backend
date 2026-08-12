import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { sendExternalMessage } from "../../../connectors/external-dispatch.js";
import { getMessagingConnector } from "../../../connectors/index.js";
import { assertApprovalTargetResolves } from "../../../services/capabilities/execute-capability.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
} from "../execution-registry.js";
import { reportApproved, dispatchExternalOnce } from "./shared.js";

const logger = createLogger({ module: "proposal-approve-executors-messaging" });

/** Register the messaging.external.send approve executor. */
export function registerMessagingExecutors(): void {
  // ── messaging.external.send (proposalType-only) ─────────────────────────────
  registerProposalExecutor({
    key: "messaging.external.send",
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
      const threadId = data.threadId as string | undefined;
      const body = data.body as string | undefined;
      const platform = data.platform as string | undefined;

      if (!threadId || !body) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "External message send requires threadId and body in proposal data",
        });
      }

      // Provider-driven account resolution. Connectors with per-user accounts
      // (Unipile/Stalwart) require a messaging_accounts row; server-managed
      // connectors (Discord — shared bot token) do NOT, and ignore accountId.
      const connector = await getMessagingConnector(platform);
      const needsAccount = connector ? connector.requiresAccount() : true;

      let accountId = "";
      if (needsAccount) {
        const msgAccount = await deps.resolveMessagingAccountForPlatform(
          userId,
          platform
        );
        if (!msgAccount) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "No messaging account found for this platform — connect one first",
          });
        }
        accountId = msgAccount.id;
      }

      // Guard: only execute if not already approved (external sends are irreversible).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      // Only a confirmed-delivered send reaches the APPROVED flip below; a lost
      // claim / not-sent / ambiguous failure throws → APPROVAL_FAILED.
      await dispatchExternalOnce(input.proposalId, async () => {
        // BYPASS the capability gate: this send is already past governance (the
        // proposal was approved). `alreadyApproved` makes sendExternalMessage
        // dispatch directly, exactly once — no double-gate on re-entry.
        const {
          success: sent,
          errorClass,
          providerRef,
        } = await sendExternalMessage({
          threadId,
          accountId,
          body,
          userId,
          alreadyApproved: true,
        });
        if (!sent) {
          logger.warn(
            { proposalId: input.proposalId, threadId, platform },
            "messaging.external.send: connector reported not-sent"
          );
          return { delivered: false, errorClass, providerRef };
        }
        return { delivered: true };
      });

      const materializedPayload = {
        ...payload,
        sentResult: { sentAt: new Date().toISOString(), threadId, platform },
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
