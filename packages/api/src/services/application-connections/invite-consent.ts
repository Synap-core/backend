/**
 * The invite is the consent (founder, 2026-10-19).
 *
 * A Pod member who joined by accepting a Pod invite, and now links their
 * Synap account through a first-party app, is linked on their own Pod sign-in:
 * the owner already said yes when they invited that address. Every condition
 * below is required; anything else leaves the request pending for an owner,
 * exactly as before.
 *
 *  1. The request asks to link an account (`identity:link-user`) and is
 *     pending, redeemed by a signed-in member.
 *  2. The account is VERIFIED: the start handler checked the issuer's signed
 *     assertion against an issuer this Pod had already approved
 *     (`request_metadata.requesterAccount`), and that issuer is still approved.
 *     An unverified account always goes to the owner.
 *  3. The issuer vouched for the request's browser origin (`vouchedOrigin`,
 *     the CP's signed `origin` claim). Approving adds the origin to the app's
 *     allowlist, so an approval no owner reviewed may only ever add an origin
 *     the issuer admitted for that registered app. The signed `azp` already
 *     equals the request's client id (the start refuses a mismatch), and the
 *     CP signs `azp` only for a client in its registry.
 *  4. The member accepted a POD invite sent to that same verified address, and
 *     that invite's OWN window (`invites.expires_at`, 7 days at creation in
 *     `workspaces.createInvite`) is still open now. No new TTL.
 *
 * Approval goes through the same door an owner's does
 * (`FederatedApplicationConnectionService.approve`), with the invite as the
 * reviewer of record (`invited_by`) and `approvedByInvite` in the request's
 * metadata. The Pod owners and admins are told, with a way to revoke.
 */

import { createLogger } from "@synap-core/core";
import {
  FederatedApplicationConnectionService,
  TrustedIssuerService,
  findOpenPodInviteAcceptance,
  db,
  eq,
  users,
  type InviteAcceptance,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolvePodAdminUserIds } from "../capabilities/pod-owner.js";
import {
  INVITE_APPROVAL_METADATA_KEY,
  readVerifiedRequesterAccount,
  type InviteApprovalRecord,
} from "../../utils/application-connection.js";

const logger = createLogger({ module: "invite-consent" });

// Spelled `notificationType =` so the producer tripwire
// (`notification-producer-allowlist`) sees this file produce it.
const notificationType = "application_connection.linked_by_invite";
export const INVITE_LINKED_NOTIFICATION_TYPE = notificationType;

type ConnectionRequest = NonNullable<
  Awaited<ReturnType<FederatedApplicationConnectionService["getRequest"]>>
>;

export type InviteConsentOutcome =
  | {
      kind: "approved";
      inviteId: string;
      invitedBy: string;
      connectionId: string;
    }
  | {
      kind: "owner_review";
      reason:
        | "not_pending"
        | "not_an_account_link"
        | "unverified"
        | "issuer_not_approved"
        | "origin_not_vouched"
        | "no_open_invite"
        | "check_failed"
        | "approval_failed";
    };

export interface InviteConsentDeps {
  issuerStatus(issuerUrl: string): Promise<string | null>;
  findInvite(input: {
    userId: string;
    email: string;
    now: Date;
  }): Promise<InviteAcceptance | null>;
  approve(
    input: Parameters<FederatedApplicationConnectionService["approve"]>[0]
  ): Promise<{ connection: { id: string } }>;
  recipients(): Promise<string[]>;
  memberName(userId: string): Promise<string>;
  notify(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<unknown>;
  now(): Date;
}

const connectionService = new FederatedApplicationConnectionService();

const defaultDeps: InviteConsentDeps = {
  issuerStatus: async (issuerUrl) =>
    (await new TrustedIssuerService().getByUrl(issuerUrl))?.status ?? null,
  findInvite: (input) => findOpenPodInviteAcceptance(input),
  approve: (input) => connectionService.approve(input),
  recipients: resolvePodAdminUserIds,
  memberName: async (userId) => {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    return user?.name?.trim() || user?.email || "A Pod member";
  },
  notify: (input) => NotificationService.create(input),
  now: () => new Date(),
};

export async function approveByInviteIfConsented(
  request: ConnectionRequest,
  deps: InviteConsentDeps = defaultDeps
): Promise<InviteConsentOutcome> {
  try {
    return await decideAndApprove(request, deps);
  } catch (error) {
    // A read failed before anything was approved. The redeem itself already
    // succeeded, so the request waits for an owner instead of failing the
    // member's sign-in.
    logger.warn(
      { error, requestId: request.id },
      "Invite-consent check failed; the request waits for an owner"
    );
    return { kind: "owner_review", reason: "check_failed" };
  }
}

async function decideAndApprove(
  request: ConnectionRequest,
  deps: InviteConsentDeps
): Promise<InviteConsentOutcome> {
  const ownerReview = (
    reason: Extract<InviteConsentOutcome, { kind: "owner_review" }>["reason"]
  ) => ({ kind: "owner_review" as const, reason });

  const requesterId = request.requestedByUserId;
  if (request.status !== "pending" || !requesterId) {
    return ownerReview("not_pending");
  }
  if (!request.requestedScopes.includes("identity:link-user")) {
    return ownerReview("not_an_account_link");
  }
  const account = readVerifiedRequesterAccount(request.requestMetadata);
  if (!account || account.issuerUrl !== request.issuerUrl) {
    return ownerReview("unverified");
  }
  if ((await deps.issuerStatus(account.issuerUrl)) !== "approved") {
    return ownerReview("issuer_not_approved");
  }
  if (account.vouchedOrigin !== request.requestedOrigin) {
    return ownerReview("origin_not_vouched");
  }
  const now = deps.now();
  const invite = await deps.findInvite({
    userId: requesterId,
    email: account.verifiedEmail,
    now,
  });
  if (!invite) return ownerReview("no_open_invite");

  const approval: InviteApprovalRecord = {
    inviteId: invite.inviteId,
    inviteAcceptedAt: invite.acceptedAt.toISOString(),
    approvedAt: now.toISOString(),
  };
  let connectionId: string;
  try {
    const approved = await deps.approve({
      requestId: request.id,
      reviewerUserId: invite.invitedBy,
      approvalMetadata: { [INVITE_APPROVAL_METADATA_KEY]: approval },
    });
    connectionId = approved.connection.id;
  } catch (error) {
    // The transaction rolled back: the request is still pending, and an
    // owner decides it the ordinary way.
    logger.warn(
      { error, requestId: request.id },
      "Invite-consent approval failed; the request waits for an owner"
    );
    return ownerReview("approval_failed");
  }

  // Tell the owners. The link already happened, so a failed notice is logged,
  // never turned into a failed approval.
  try {
    const [recipients, memberName] = await Promise.all([
      deps.recipients(),
      deps.memberName(requesterId),
    ]);
    for (const userId of recipients) {
      await deps.notify({
        type: INVITE_LINKED_NOTIFICATION_TYPE,
        workspaceId: null,
        userId,
        sourceType: "system",
        sourceId: connectionId,
        data: {
          email: account.verifiedEmail,
          memberName,
          appName: request.displayName,
        },
      });
    }
  } catch (error) {
    logger.error(
      { error, requestId: request.id, connectionId },
      "Linked by invite, but the Pod owners could not be notified"
    );
  }

  return {
    kind: "approved",
    inviteId: invite.inviteId,
    invitedBy: invite.invitedBy,
    connectionId,
  };
}
