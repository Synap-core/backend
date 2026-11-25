import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  ne,
  drizzleSql,
  transitionProposal,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { assertPodAdmin } from "../../../trpc.js";
import {
  claimConnectAttempt,
  connectInboundSourceToHost,
  INBOUND_SOURCE_HOSTS,
  INBOUND_SOURCE_TARGETS,
  readConnectProposalRow,
  type InboundSourceConnectProgress,
  type InboundSourceConnectRequest,
} from "../../../services/webhooks/connect-inbound-source.js";
import { registerProposalExecutor } from "../execution-registry.js";
import {
  classifyThrownFailure,
  failureRecord,
  keepRowAsRecorded,
  leaveRowToOtherAttempt,
  safeFailureSentence,
} from "../failure-classification.js";
import { reportApproved } from "./shared.js";

/**
 * The request the card stored at filing (`data.request`), re-read strictly:
 * a row the pod wrote, but the approval is a credential act and acts on
 * nothing it cannot read exactly.
 */
function readStoredRequest(data: Record<string, unknown>) {
  const r = (data.request ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const request: InboundSourceConnectRequest = {
    workspaceId: str("workspaceId"),
    name: str("name"),
    host: str("host") as InboundSourceConnectRequest["host"],
    project: str("project"),
    ...(str("teamId") ? { teamId: str("teamId") } : {}),
    urlEnvKey: str("urlEnvKey"),
    secretEnvKey: str("secretEnvKey"),
    target: str("target") as InboundSourceConnectRequest["target"],
    redeploy: r.redeploy === true,
    replaceExistingSecret: r.replaceExistingSecret === true,
  };
  if (
    !request.workspaceId ||
    !request.name ||
    !request.project ||
    !request.urlEnvKey ||
    !request.secretEnvKey ||
    !INBOUND_SOURCE_HOSTS.includes(request.host) ||
    !INBOUND_SOURCE_TARGETS.includes(request.target)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This connect request is incomplete; nothing was created. File it again with inbound_source.connect.",
    });
  }
  return request;
}

/**
 * What the card showed (`data.preview`): the project and the source the
 * person approved. A card without them was not filed by this door.
 */
function readAnnouncedTargets(data: Record<string, unknown>) {
  const preview = (data.preview ?? {}) as Record<string, unknown>;
  const host = (preview.host ?? {}) as Record<string, unknown>;
  const source = (preview.source ?? {}) as Record<string, unknown>;
  if (typeof host.projectId !== "string" || !host.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This connect request carries no project the person saw; nothing was created. File it again with inbound_source.connect.",
    });
  }
  return {
    projectId: host.projectId,
    existingSourceId:
      typeof source.existingId === "string" ? source.existingId : null,
  };
}

export function registerWebhookExecutors(): void {
  /**
   * Approve-executor for `webhook/inbound_source.connect` (decision
   * abaaa696): mint a space's inbound source and hand its secret to the host
   * (`services/webhooks/connect-inbound-source.ts`). WIDENS A CREDENTIAL: a
   * console approval with fresh authentication, never a device session, and
   * only a POD ADMIN (the bar of `adminCreateInboundSource`: creating a
   * source re-binds other members' automations).
   *
   * A failure after the source exists records ITSELF, merging the failure
   * into the row's CURRENT data: the generic approval catch writes the data
   * it loaded before the run, which would erase `data.progress`, and the
   * retry needs it to know which source this proposal minted.
   *
   * ONE ATTEMPT AT A TIME (`claimConnectAttempt`): a second approval while
   * one runs mints nothing and sends nothing; the attempt's final writes are
   * guarded on its own claim, and a failure releases it for the retry.
   */
  registerProposalExecutor({
    key: "webhook/inbound_source.connect",
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      await assertPodAdmin(userId);

      const before = await readConnectProposalRow(input.proposalId);
      if (before?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }
      const claim = await claimConnectAttempt(input.proposalId);
      if (!claim) {
        const now = await readConnectProposalRow(input.proposalId);
        if (now?.status === ProposalStatus.APPROVED) {
          return { success: true, alreadyApproved: true };
        }
        // The running attempt records its own outcome on the row.
        throw leaveRowToOtherAttempt(
          new TRPCError({
            code: "CONFLICT",
            message:
              "Another approval of this connect is running right now. Nothing was created or sent again; its result will show on this card.",
          })
        );
      }
      // Read under the claim: the progress an earlier attempt stamped.
      const row = await readConnectProposalRow(input.proposalId);
      const ours = and(
        eq(proposals.id, input.proposalId),
        eq(proposals.externalDispatchedAt, claim)
      );

      let receipt;
      try {
        const data = (row?.data ?? proposal.data ?? {}) as Record<
          string,
          unknown
        >;
        const request = readStoredRequest(data);
        const announced = readAnnouncedTargets(data);
        const progress = (data.progress ?? {}) as InboundSourceConnectProgress;
        receipt = await connectInboundSourceToHost({
          proposalId: input.proposalId,
          approverUserId: userId,
          request,
          progress,
          announced,
        });
      } catch (err) {
        const failure = classifyThrownFailure(err);
        // Released with the failure, so approving again retries.
        await transitionProposal(db, {
          to: ProposalStatus.APPROVAL_FAILED,
          set: {
            rejectionReason: safeFailureSentence(err, failure),
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
            externalDispatchedAt: null,
            data: drizzleSql`coalesce(${proposals.data}, '{}'::jsonb) || jsonb_build_object('failure', ${JSON.stringify(failureRecord(failure))}::jsonb)`,
          },
          where: and(ours, ne(proposals.status, ProposalStatus.APPROVED)),
        });
        throw keepRowAsRecorded(
          err instanceof Error ? err : new Error(String(err))
        );
      }

      const landed = await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          data: drizzleSql`(coalesce(${proposals.data}, '{}'::jsonb) - 'failure') || jsonb_build_object('receipt', ${JSON.stringify(receipt)}::jsonb)`,
        },
        where: ours,
      }).returning({ id: proposals.id });
      if (landed.length === 0) {
        // This attempt outlived its claim and another took the card over:
        // that one records the outcome.
        throw leaveRowToOtherAttempt(
          new TRPCError({
            code: "CONFLICT",
            message:
              "This approval ran past its turn and another approval took the card over; its result will show on this card.",
          })
        );
      }

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return {
        success: true,
        primaryId: receipt.source.id,
        effect: {
          applied: "verified",
          rows: 1,
          ids: [receipt.source.id],
          subject: "webhook_subscriptions",
        },
      };
    },
  });
}
