import { TRPCError } from "@trpc/server";
import { db, proposals, eq, transitionProposal } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { sendExternalMessage } from "../../../connectors/external-dispatch.js";
import { getMessagingConnector } from "../../../connectors/index.js";
import { assertApprovalTargetResolves } from "../../../services/capabilities/execute-capability.js";
import {
  findOwnMessagingAccount,
  queueOwnerHistoryImport,
} from "../../../services/connectors/owner-history-import.js";
import {
  deleteLinkedExternalChannel,
  disconnectOwnMessagingAccount,
  findVisibleLinkedExternalChannel,
} from "../../../services/connectors/owner-messaging-writes.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
  type ProposalExecutorArgs,
} from "../execution-registry.js";
import { reportApproved, dispatchExternalOnce } from "./shared.js";

const logger = createLogger({ module: "proposal-approve-executors-messaging" });

/** Register the messaging approve executors (send, history import, disconnect, unlink). */
export function registerMessagingExecutors(): void {
  // ── messaging/delete_account ───────────────────────────────────────────────
  // An agent asked to disconnect an account (`DELETE /messaging/accounts/:id`).
  // Approving disconnects it through the same door as the person's own call,
  // as the approver, who must own the account (the row's target, set at
  // filing). Re-approving does nothing.
  registerProposalExecutor({
    key: "messaging/delete_account",
    async execute({ proposal, payload, userId, input, deps }) {
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const account = await findOwnMessagingAccount(userId, proposal.targetId);
      if (!account) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Couldn't apply — this messaging account is not yours, or it is already gone. Nothing was disconnected.",
          }),
          { errorClass: "conflict" }
        );
      }
      const connector = await getMessagingConnector();
      if (!connector) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Couldn't apply — no messaging service is set up on this pod. Nothing was disconnected.",
          }),
          { errorClass: "conflict" }
        );
      }
      await disconnectOwnMessagingAccount(connector, account);
      await markApproved(input.proposalId, payload, userId, {
        disconnectedAt: new Date().toISOString(),
      });
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

  // ── channel/delete_external ────────────────────────────────────────────────
  // An agent asked to unlink an external conversation (`DELETE
  // /messaging/channels/:id`). Approving deletes it as the approver, who must
  // still see the channel (the row's target, set at filing). A channel already
  // gone is a conflict, never a silent success.
  registerProposalExecutor({
    key: "channel/delete_external",
    async execute({ proposal, payload, userId, input, deps }) {
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const channel = await findVisibleLinkedExternalChannel(
        userId,
        proposal.targetId
      );
      if (!channel || !(await deleteLinkedExternalChannel(channel.id))) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Couldn't apply — this conversation is not one you can see, or it was already unlinked. Nothing was deleted.",
          }),
          { errorClass: "conflict" }
        );
      }
      await markApproved(input.proposalId, payload, userId, {
        deletedAt: new Date().toISOString(),
      });
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

  // ── messaging/import_history ───────────────────────────────────────────────
  // An agent asked for an account's history import (`POST
  // /messaging/accounts/:id/import-history`). Approving queues it through the
  // same door the person's own call uses, as the approver — who must own the
  // account: the account is the row's target, set at filing.
  registerProposalExecutor({
    key: "messaging/import_history",
    async execute({ proposal, payload, userId, input, deps }) {
      const [current] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (current?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }
      const account = await findOwnMessagingAccount(userId, proposal.targetId);
      if (!account) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Couldn't apply — this messaging account is not yours, or it was disconnected. Nothing was imported.",
          }),
          { errorClass: "conflict" }
        );
      }
      const result = await queueOwnerHistoryImport(userId, account);
      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          data: {
            ...payload,
            importResult: {
              queuedAt: new Date().toISOString(),
              queued: result.queued,
            },
          } as unknown as typeof payload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });
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
      // A proposed message on a person's channel (channels wave, lane D):
      // delivered ON the channel — a chat id when it has one, else the chat is
      // started (1st-degree check first) and its id fills the channel.
      if (typeof data.channelId === "string" && data.channelId) {
        // WHO it goes to is the row's target, set at filing and never
        // revisable. A data.channelId that moved off it is a recipient swap:
        // refused, nothing sent.
        if (data.channelId !== proposal.targetId) {
          throw attachFailureMeta(
            new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Couldn't apply — this message's conversation was changed after it was filed. Nothing was sent; file it again.",
            }),
            { errorClass: "conflict" }
          );
        }
        return executeChannelSend({
          proposal,
          payload,
          data,
          channelId: proposal.targetId,
          userId,
          input,
          deps,
        });
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
        // The provider's account id — every connector hands it straight to
        // the provider as its external account id; the pod row id is unknown
        // there.
        accountId = msgAccount.externalId;
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
          error,
          errorClass,
          providerRef,
        } = await sendExternalMessage({
          threadId,
          accountId,
          body,
          userId,
          alreadyApproved: true,
          // The session it was asked in: a worker's send ceiling counts by it.
          sessionId: proposal.sessionId ?? null,
        });
        if (!sent) {
          logger.warn(
            { proposalId: input.proposalId, threadId, platform },
            "messaging.external.send: connector reported not-sent"
          );
          return { delivered: false, reason: error, errorClass, providerRef };
        }
        return { delivered: true };
      });

      const materializedPayload = {
        ...payload,
        sentResult: { sentAt: new Date().toISOString(), threadId, platform },
      } as unknown as typeof payload;

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

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

/**
 * Approve a proposed message on a person's channel. At most once
 * (`dispatchExternalOnce`): a second approval finds the claim and sends
 * nothing; a refusal before any send (not a connection, no account) releases
 * the claim and keeps the proposal pending with its next action.
 */
async function executeChannelSend(args: {
  proposal: ProposalExecutorArgs["proposal"];
  payload: ProposalExecutorArgs["payload"];
  data: Record<string, unknown>;
  channelId: string;
  userId: string;
  input: ProposalExecutorArgs["input"];
  deps: ProposalExecutorArgs["deps"];
}) {
  const { proposal, payload, data, userId, input, deps } = args;
  const body = typeof data.body === "string" ? data.body : "";
  if (!body) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This proposed message has no text.",
    });
  }

  const [alreadyDone] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId));
  if (alreadyDone?.status === ProposalStatus.APPROVED) {
    return { success: true, alreadyApproved: true };
  }

  let sent: Awaited<ReturnType<typeof sendExternalMessage>> | null = null;
  await dispatchExternalOnce(input.proposalId, async () => {
    const result = await sendExternalMessage({
      channelId: args.channelId,
      threadId: null,
      accountId: typeof data.accountId === "string" ? data.accountId : "",
      body,
      userId,
      workspaceId: proposal.workspaceId ?? null,
      alreadyApproved: true,
      sessionId: proposal.sessionId ?? null,
      proposalId: input.proposalId,
      subject: typeof data.subject === "string" ? data.subject : null,
      draftedBy:
        data.draftedBy && typeof data.draftedBy === "object"
          ? (data.draftedBy as {
              agentUserId: string | null;
              appClientId: string | null;
            })
          : null,
    });
    if (!result.success) {
      logger.warn(
        {
          proposalId: input.proposalId,
          channelId: args.channelId,
          errorClass: result.errorClass,
        },
        "messaging.external.send: not sent on the channel"
      );
      return {
        delivered: false,
        reason: result.error,
        errorClass: result.errorClass,
        providerRef: result.providerRef,
      };
    }
    sent = result;
    return { delivered: true };
  });
  const done = sent as Awaited<ReturnType<typeof sendExternalMessage>> | null;

  // The message may have landed in the channel that already held the chat:
  // the proposal then points there.
  const materializedPayload = {
    ...payload,
    ...(done?.channelId ? { channelId: done.channelId } : {}),
    ...(done?.chatId ? { threadId: done.chatId } : {}),
    sentResult: {
      sentAt: new Date().toISOString(),
      channelId: done?.channelId ?? args.channelId,
      chatId: done?.chatId ?? null,
      messageId: done?.messageId ?? null,
      externalMessageId: done?.externalMessageId ?? null,
      first: done?.first ?? false,
      platform: data.platform ?? null,
    },
  } as unknown as typeof payload;

  await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: {
      data: materializedPayload,
      ...(done?.channelId && done.channelId !== proposal.targetId
        ? { targetId: done.channelId }
        : {}),
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    },
    where: eq(proposals.id, input.proposalId),
  });

  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );
  return { success: true };
}

/** Has this proposal already been applied (a second approval does nothing)? */
async function alreadyApproved(proposalId: string): Promise<boolean> {
  const [current] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return current?.status === ProposalStatus.APPROVED;
}

/** Flip the proposal to approved, recording what was applied. */
async function markApproved(
  proposalId: string,
  payload: ProposalExecutorArgs["payload"],
  userId: string,
  applied: Record<string, unknown>
): Promise<void> {
  await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: {
      data: { ...payload, applied } as unknown as typeof payload,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    },
    where: eq(proposals.id, proposalId),
  });
}
