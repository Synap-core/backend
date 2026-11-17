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
   */
  registerProposalExecutor({
    key: "webhook/inbound_source.connect",
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      await assertPodAdmin(userId);

      const row = await readConnectProposalRow(input.proposalId);
      if (row?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }
      const data = (row?.data ?? proposal.data ?? {}) as Record<
        string,
        unknown
      >;
      const request = readStoredRequest(data);
      const progress = (data.progress ?? {}) as InboundSourceConnectProgress;

      let receipt;
      try {
        receipt = await connectInboundSourceToHost({
          proposalId: input.proposalId,
          approverUserId: userId,
          request,
          progress,
        });
      } catch (err) {
        const failure = classifyThrownFailure(err);
        await transitionProposal(db, {
          to: ProposalStatus.APPROVAL_FAILED,
          set: {
            rejectionReason: safeFailureSentence(err, failure),
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
            data: drizzleSql`coalesce(${proposals.data}, '{}'::jsonb) || jsonb_build_object('failure', ${JSON.stringify(failureRecord(failure))}::jsonb)`,
          },
          where: and(
            eq(proposals.id, input.proposalId),
            ne(proposals.status, ProposalStatus.APPROVED)
          ),
        });
        throw keepRowAsRecorded(
          err instanceof Error ? err : new Error(String(err))
        );
      }

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          data: drizzleSql`(coalesce(${proposals.data}, '{}'::jsonb) - 'failure') || jsonb_build_object('receipt', ${JSON.stringify(receipt)}::jsonb)`,
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
