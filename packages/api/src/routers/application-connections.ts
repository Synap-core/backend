/**
 * Pod-owner administration for browser origin allowlisting (application plane).
 *
 * Approving a request allows that exact browser Origin to call this Pod
 * (CORS / transport). Trusted issuers (JWT crypto) are a separate plane under
 * Trust & Keys — this router does not replace issuer approval, membership, or
 * data permissions. Approving may still ensure the named CP issuer exists so
 * handshakes can verify signatures; that is a side effect, not the product.
 *
 * Every lifecycle act is an event (`recordConnectionEvent`): a request's on
 * the request (`application_connection.{request|reject}.completed`), an
 * approval's and a revoke's on the connection
 * (`application_connection.{approve|revoke}.completed`). The connection page
 * reads both through `get`'s `requestIds`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  desc,
  eq,
  and,
  count,
  inArray,
  max,
  FederatedApplicationConnectionService,
  federatedAccessReceipts,
  federatedApplicationConnectionRequests,
  federatedApplicationConnections,
  federatedIdentityLinks,
  trustedIssuers,
  TrustedIssuerService,
  users,
  workspaces,
} from "@synap/database";
import {
  router,
  podAdminProcedure,
  protectedProcedure,
  credentialProcedure,
  refuseDeviceSession,
} from "../trpc.js";
import { auditLog } from "../utils/audit-log.js";
import {
  buildApplicationConnectionReturnUrl,
  hashOpaqueApplicationConnectionValue,
  markLinkedByInvite,
  readInviteApproval,
  requesterAccountView,
} from "../utils/application-connection.js";
import { approveByInviteIfConsented } from "../services/application-connections/invite-consent.js";
import { unlinkConnectionAccount } from "../services/application-connections/unlink-account.js";

const requestIdSchema = z.object({ requestId: z.string().uuid() });
const redeemRequestSchema = requestIdSchema.extend({
  redemptionSecret: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
});

const connectionService = new FederatedApplicationConnectionService();

/** The requests one connection page shows the activity of, newest first. */
const REQUESTS_SHOWN = 50;

/** The four acts on a sign-in app's timeline. */
type ConnectionAct = "request" | "approve" | "reject" | "revoke" | "unlink";

/** One act as a pod-wide event (no space) by the person who did it. */
async function recordConnectionEvent(args: {
  action: ConnectionAct;
  subjectId: string;
  userId: string;
  data: { displayName: string; clientId: string } & Record<string, unknown>;
}): Promise<void> {
  await auditLog({
    subjectType: "application_connection",
    action: args.action,
    phase: "completed",
    subjectId: args.subjectId,
    userId: args.userId,
    workspaceId: null,
    data: args.data,
  });
}

/**
 * Effective request status for owner UIs — must match
 * `effectiveApplicationConnectionRequestStatus` in the database service.
 * Owner decisions stay durable; only pre-decision handoffs expire.
 */
function effectiveRequestStatus(status: string, expiresAt: Date): string {
  if (
    status === "completed" ||
    status === "rejected" ||
    status === "expired" ||
    status === "approved" ||
    status === "completing"
  ) {
    return status;
  }
  return expiresAt > new Date() ? status : "expired";
}

async function canReviewPodApplicationConnections(
  userId: string
): Promise<boolean> {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) return false;
  const membership = await db.query.workspaceMembers.findFirst({
    where: (members, { and, eq }) =>
      and(
        eq(members.workspaceId, podAdminWorkspace.id),
        eq(members.userId, userId)
      ),
    columns: { role: true },
  });
  return membership?.role === "owner" || membership?.role === "admin";
}

/** Origin allowlist only — does not require a particular trusted issuer. */
/** The trusted issuer's own name on this Pod, or null when it has none. */
async function issuerDisplayName(issuerUrl: string): Promise<string | null> {
  const issuer = await new TrustedIssuerService().getByUrl(issuerUrl);
  return issuer?.displayName?.trim() || null;
}

async function matchingApprovedConnection(input: {
  clientId: string;
  origin: string;
}): Promise<boolean> {
  const connection = await db.query.federatedApplicationConnections.findFirst({
    where: and(
      eq(federatedApplicationConnections.clientId, input.clientId),
      eq(federatedApplicationConnections.status, "approved")
    ),
    columns: { allowedOrigins: true },
  });
  return Boolean(connection?.allowedOrigins.includes(input.origin));
}

/**
 * How much a connection is used, read from what the pod already records —
 * no new column. Both facts are keyed by ISSUER, not by client: an identity
 * link and an access receipt name the issuer that vouched for the person,
 * never the browser app they came through. So they are the usage of the
 * issuer a connection was registered under, which is the connection's own
 * usage in the common one-app-per-issuer case and an upper bound otherwise.
 *
 *   lastUsedAt — the newest issuer-authorized access command the pod applied
 *                (`federated_access_receipts.applied_at`); null = never.
 *   people     — how many pod users signed in through that issuer
 *                (`federated_identity_links`).
 *
 * Two grouped queries for any number of connections (`issuerIds` narrows them
 * to the ones asked for).
 */
async function issuerUsage(issuerIds?: readonly string[]) {
  const narrowReceipts =
    issuerIds && inArray(federatedAccessReceipts.issuerId, [...issuerIds]);
  const narrowLinks =
    issuerIds && inArray(federatedIdentityLinks.issuerId, [...issuerIds]);
  const [receipts, links] = await Promise.all([
    db
      .select({
        issuerId: federatedAccessReceipts.issuerId,
        lastUsedAt: max(federatedAccessReceipts.appliedAt),
      })
      .from(federatedAccessReceipts)
      .where(narrowReceipts || undefined)
      .groupBy(federatedAccessReceipts.issuerId),
    db
      .select({
        issuerId: federatedIdentityLinks.issuerId,
        people: count(),
      })
      .from(federatedIdentityLinks)
      .where(narrowLinks || undefined)
      .groupBy(federatedIdentityLinks.issuerId),
  ]);
  const lastUsed = new Map(receipts.map((r) => [r.issuerId, r.lastUsedAt]));
  const people = new Map(links.map((l) => [l.issuerId, Number(l.people)]));
  return (issuerId: string) => ({
    lastUsedAt: lastUsed.get(issuerId) ?? null,
    peopleCount: people.get(issuerId) ?? 0,
  });
}

/** The Pod member who signed in to start the request, as a reviewer reads them. */
type RequesterMember = { name: string | null; email: string | null };

function reviewShape(
  request: NonNullable<
    Awaited<ReturnType<FederatedApplicationConnectionService["getRequest"]>>
  >,
  canReview: boolean,
  options: {
    viewerUserId: string;
    matchingApprovedConnection?: boolean;
    /** The trusted issuer's display name, for "Verified by …". */
    issuerName?: string | null;
    requesterMember?: RequesterMember | null;
  }
) {
  const effectiveStatus = effectiveRequestStatus(
    request.status,
    request.expiresAt
  );
  const matching = options.matchingApprovedConnection === true && canReview;
  // An account link (the app asks to link the requester's account) versus an
  // origin-only request. Only a link has an account to name.
  const isAccountLink = request.requestedScopes.includes("identity:link-user");
  const accountView = isAccountLink
    ? requesterAccountView(request.requestMetadata, {
        issuerName: options.issuerName,
      })
    : null;
  const approvedByInvite = readInviteApproval(request.requestMetadata) !== null;
  if (!canReview) {
    // The opaque callback and exact issuer/origin pair are an owner review
    // artifact. A requester or ordinary member only needs the current state
    // and clear owner guidance, not a reconnaissance view of every pending
    // external application registration on the Pod.
    const isRequester = request.requestedByUserId === options.viewerUserId;
    const linked =
      effectiveStatus === "approved" || effectiveStatus === "completed";
    return {
      id: request.id,
      issuerUrl: "Visible to Pod owners and administrators",
      clientId: "Visible to Pod owners and administrators",
      // The requester started this from their own app; they may see its name.
      displayName: isRequester ? request.displayName : "An application",
      publisherUrl: null,
      requestedOrigin: "Visible to Pod owners and administrators",
      requestedCallbackUrl: "Visible to Pod owners and administrators",
      requestedScopes: [],
      status: effectiveStatus,
      decisionReason: request.decisionReason,
      expiresAt: request.expiresAt,
      reviewedAt: request.reviewedAt,
      canReview: false,
      matchingApprovedConnection: false,
      // The requester sees their OWN account; nobody else sees it here.
      requesterAccount: isRequester ? accountView : null,
      requesterMember: null,
      approvedByInvite,
      approvedConnectionId: null,
      // Back to their app once linked. Not an authority: completion still
      // needs the continuation only the requester's app holds.
      returnUrl:
        isRequester && linked
          ? buildApplicationConnectionReturnUrl({
              callbackUrl: request.requestedCallbackUrl,
              requestId: request.id,
            })
          : null,
    };
  }
  return {
    id: request.id,
    issuerUrl: request.issuerUrl,
    clientId: request.clientId,
    displayName: request.displayName,
    publisherUrl: request.publisherUrl,
    requestedOrigin: request.requestedOrigin,
    requestedCallbackUrl: request.requestedCallbackUrl,
    requestedScopes: request.requestedScopes,
    status: effectiveStatus,
    decisionReason: request.decisionReason,
    expiresAt: request.expiresAt,
    reviewedAt: request.reviewedAt,
    canReview,
    matchingApprovedConnection: matching,
    /**
     * The account that will receive access, verified or explicitly not; null
     * for an origin-only request, which links no account.
     */
    requesterAccount: accountView,
    /** The Pod member that account will sign in as. */
    requesterMember: options.requesterMember ?? null,
    approvedByInvite,
    /** The app's page in Pod Admin, once approved (`/applications/sign-in/<id>`). */
    approvedConnectionId: request.approvedConnectionId,
    returnUrl: null,
  };
}

export const applicationConnectionsRouter = router({
  /**
   * The browser reached this Pod-owned route through a public, non-authorizing
   * handoff. Redeem it only after Pod Admin's local Kratos session exists;
   * this is what binds the later review request to a real Pod user.
   */
  redeemRequest: credentialProcedure
    .input(redeemRequestSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Redeeming is idempotent (a refresh lands here again): only the
        // first redeem is the ask.
        const { request, firstRedeem } = await connectionService.redeemRequest({
          requestId: input.requestId,
          redemptionHash: hashOpaqueApplicationConnectionValue(
            input.redemptionSecret
          ),
          requestedByUserId: ctx.userId,
        });
        // Only the redeem that won the service's UPDATE…RETURNING is the ask;
        // a concurrent or repeated redeem records nothing and links nothing.
        if (!firstRedeem) {
          return { requestId: request.id, linkedByInvite: false };
        }
        await recordConnectionEvent({
          action: "request",
          subjectId: request.id,
          userId: ctx.userId,
          data: {
            displayName: request.displayName,
            clientId: request.clientId,
            origin: request.requestedOrigin,
          },
        });
        // The invite is the consent: a member who joined by a Pod invite and
        // whose Synap account is verified is linked now, with no second owner
        // approval. Anything short of every condition stays pending.
        const consent = await approveByInviteIfConsented(request);
        if (consent.kind === "approved") {
          await recordConnectionEvent({
            action: "approve",
            subjectId: consent.connectionId,
            userId: consent.invitedBy,
            data: {
              displayName: request.displayName,
              clientId: request.clientId,
              requestId: request.id,
              origin: request.requestedOrigin,
              approvedByInvite: consent.inviteId,
            },
          });
        }
        return {
          requestId: request.id,
          linkedByInvite: consent.kind === "approved",
        };
      } catch (error) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            error instanceof Error
              ? error.message
              : "Could not prepare this application connection request",
        });
      }
    }),

  /** A signed-in member may open a request link and see whether an owner must act. */
  getReviewRequest: protectedProcedure
    .input(requestIdSchema)
    .query(async ({ input, ctx }) => {
      const request = await connectionService.getRequest(input.requestId);
      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Connection request not found",
        });
      }
      const canReview = await canReviewPodApplicationConnections(ctx.userId);
      // A request id is a public browser-correlation value, not an intra-Pod
      // discovery token. Ordinary members may see only their own requester
      // guidance; owners/admins may inspect the security-relevant proposal.
      if (!canReview && request.requestedByUserId !== ctx.userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Connection request not found",
        });
      }
      const [matching, issuerName, requesterMember] = await Promise.all([
        canReview &&
          matchingApprovedConnection({
            clientId: request.clientId,
            origin: request.requestedOrigin,
          }),
        issuerDisplayName(request.issuerUrl),
        canReview && request.requestedByUserId
          ? db.query.users
              .findFirst({
                where: eq(users.id, request.requestedByUserId),
                columns: { name: true, email: true },
              })
              .then((member) =>
                member
                  ? { name: member.name ?? null, email: member.email ?? null }
                  : null
              )
          : null,
      ]);
      return reviewShape(request, canReview, {
        viewerUserId: ctx.userId,
        matchingApprovedConnection: matching === true,
        issuerName,
        requesterMember,
      });
    }),

  list: podAdminProcedure.query(async () => {
    const [connectionRows, requests, usageOf] = await Promise.all([
      // Keep the issuer URL beside each connection in the owner audit view.
      // This is an inner join because a connection cannot exist without its
      // referenced trusted issuer; it avoids a per-row lookup while preserving
      // the generic Pod-owned issuer/application model.
      db
        .select({
          connection: federatedApplicationConnections,
          issuerUrl: trustedIssuers.issuerUrl,
        })
        .from(federatedApplicationConnections)
        .innerJoin(
          trustedIssuers,
          eq(federatedApplicationConnections.issuerId, trustedIssuers.id)
        )
        .orderBy(desc(federatedApplicationConnections.updatedAt)),
      db.query.federatedApplicationConnectionRequests.findMany({
        orderBy: (table, { desc }) => [desc(table.createdAt)],
        limit: 100,
      }),
      issuerUsage(),
    ]);
    return {
      connections: connectionRows.map(({ connection, issuerUrl }) => ({
        ...connection,
        issuerUrl,
        ...usageOf(connection.issuerId),
      })),
      // Owner inventory needs the proposal and its lifecycle, never either
      // browser-held capability hash. Keeping those out of the tRPC payload
      // avoids copying them into client caches or diagnostics.
      // status is the effective (expiry-aware) status so the list never shows
      // a timed-out handoff as still pending.
      requests: requests.map(
        ({
          continuationHash: _continuationHash,
          redemptionHash: _redemptionHash,
          ...request
        }) => ({
          ...request,
          status: effectiveRequestStatus(request.status, request.expiresAt),
        })
      ),
    };
  }),

  /**
   * One connection — the console's app page: the ledger row, its issuer, its
   * usage (`issuerUsage`) and WHO uses it, the pod users linked through its
   * issuer (newest link first). Same capability-hash discipline as `list`:
   * the connection row holds none.
   */
  get: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [row] = await db
        .select({
          connection: federatedApplicationConnections,
          issuerUrl: trustedIssuers.issuerUrl,
        })
        .from(federatedApplicationConnections)
        .innerJoin(
          trustedIssuers,
          eq(federatedApplicationConnections.issuerId, trustedIssuers.id)
        )
        .where(eq(federatedApplicationConnections.id, input.id))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application connection not found",
        });
      }
      const issuerId = row.connection.issuerId;
      const [usageOf, people, requests] = await Promise.all([
        issuerUsage([issuerId]),
        db
          .select({
            userId: federatedIdentityLinks.userId,
            name: users.name,
            email: users.email,
            linkedAt: federatedIdentityLinks.linkedAt,
          })
          .from(federatedIdentityLinks)
          .innerJoin(users, eq(federatedIdentityLinks.userId, users.id))
          .where(eq(federatedIdentityLinks.issuerId, issuerId))
          .orderBy(desc(federatedIdentityLinks.linkedAt)),
        // Every ask from this app through this issuer — approved or turned
        // down — since a connection is one (issuer, client) pair.
        db
          .select({
            id: federatedApplicationConnectionRequests.id,
            requestedByUserId:
              federatedApplicationConnectionRequests.requestedByUserId,
            requestMetadata:
              federatedApplicationConnectionRequests.requestMetadata,
          })
          .from(federatedApplicationConnectionRequests)
          .where(
            and(
              eq(
                federatedApplicationConnectionRequests.issuerUrl,
                row.issuerUrl
              ),
              eq(
                federatedApplicationConnectionRequests.clientId,
                row.connection.clientId
              )
            )
          )
          .orderBy(desc(federatedApplicationConnectionRequests.createdAt))
          .limit(REQUESTS_SHOWN),
      ]);
      return {
        ...row.connection,
        issuerUrl: row.issuerUrl,
        ...usageOf(issuerId),
        // Who was linked because their invite was the consent, not an owner.
        people: markLinkedByInvite(people, requests),
        /** The asks its Activity also reads (request and turn-down events). */
        requestIds: requests.map((r) => r.id),
      };
    }),

  /**
   * "Unlink {email}": take one person's account off this app's issuer. Owners
   * and admins only (`podAdminProcedure`). The app connection stays for
   * everyone else; see `unlinkConnectionAccount` for exactly what goes.
   */
  unlinkAccount: podAdminProcedure
    .input(z.object({ connectionId: z.string().uuid(), userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const outcome = await unlinkConnectionAccount(input);
      if (outcome.status === "no_connection") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application connection not found",
        });
      }
      if (outcome.status === "unlinked") {
        await recordConnectionEvent({
          action: "unlink",
          subjectId: input.connectionId,
          userId: ctx.userId,
          data: {
            ...outcome.app,
            unlinkedUserId: input.userId,
            email: outcome.email,
            signIn: outcome.signIn,
          },
        });
      }
      return outcome;
    }),

  approveRequest: podAdminProcedure
    .use(refuseDeviceSession)
    .input(requestIdSchema)
    .mutation(async ({ input, ctx }) => {
      let approved: Awaited<
        ReturnType<FederatedApplicationConnectionService["approve"]>
      >;
      try {
        approved = await connectionService.approve({
          requestId: input.requestId,
          reviewerUserId: ctx.userId,
        });
      } catch (error) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            error instanceof Error
              ? error.message
              : "Could not approve application connection request",
        });
      }
      await recordConnectionEvent({
        action: "approve",
        subjectId: approved.connection.id,
        userId: ctx.userId,
        data: {
          displayName: approved.connection.displayName,
          clientId: approved.connection.clientId,
          requestId: approved.request.id,
          origin: approved.request.requestedOrigin,
        },
      });
      return {
        requestId: approved.request.id,
        connectionId: approved.connection.id,
        // A reviewer may return to the app, but this public link is not the
        // completion authority. The original requester holds the opaque
        // continuation and can poll/complete from another browser.
        returnUrl: buildApplicationConnectionReturnUrl({
          callbackUrl: approved.request.requestedCallbackUrl,
          requestId: approved.request.id,
        }),
      };
    }),

  rejectRequest: podAdminProcedure
    .input(
      requestIdSchema.extend({
        reason: z.string().trim().min(3).max(1_000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      let rejected: Awaited<
        ReturnType<FederatedApplicationConnectionService["reject"]>
      >;
      try {
        rejected = await connectionService.reject({
          requestId: input.requestId,
          reviewerUserId: ctx.userId,
          reason: input.reason,
        });
      } catch (error) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            error instanceof Error
              ? error.message
              : "Could not reject application connection request",
        });
      }
      await recordConnectionEvent({
        action: "reject",
        subjectId: rejected.id,
        userId: ctx.userId,
        data: {
          displayName: rejected.displayName,
          clientId: rejected.clientId,
          origin: rejected.requestedOrigin,
        },
      });
    }),

  revokeConnection: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const [revoked] = await db
        .update(federatedApplicationConnections)
        .set({
          status: "revoked",
          reviewedBy: ctx.userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(federatedApplicationConnections.id, input.id))
        .returning({
          id: federatedApplicationConnections.id,
          displayName: federatedApplicationConnections.displayName,
          clientId: federatedApplicationConnections.clientId,
        });
      if (!revoked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application connection not found",
        });
      }
      await recordConnectionEvent({
        action: "revoke",
        subjectId: revoked.id,
        userId: ctx.userId,
        data: { displayName: revoked.displayName, clientId: revoked.clientId },
      });
      // Deliberately do not revoke the issuer here: it may serve another
      // approved client or Pod integration. Revocation immediately removes
      // this browser origin's CORS/admission route. It intentionally neither
      // changes local memberships nor invalidates a generic Pod session that
      // the person can still use directly until its ordinary expiry.
    }),
});
