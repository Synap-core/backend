/**
 * Pod-owner administration for browser application connections.
 *
 * This router manages connection review only. It deliberately does not expose
 * a new data-plane permission model: issuer capabilities and the user's Pod
 * memberships remain the authority for federation and resource access.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  desc,
  eq,
  and,
  FederatedApplicationConnectionService,
  federatedApplicationConnections,
  trustedIssuers,
  workspaces,
} from "@synap/database";
import { router, podAdminProcedure, protectedProcedure } from "../trpc.js";
import {
  buildApplicationConnectionReturnUrl,
  hashOpaqueApplicationConnectionValue,
} from "../utils/application-connection.js";

const requestIdSchema = z.object({ requestId: z.string().uuid() });
const redeemRequestSchema = requestIdSchema.extend({
  redemptionSecret: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
});

const connectionService = new FederatedApplicationConnectionService();

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

async function matchingApprovedConnection(input: {
  issuerUrl: string;
  clientId: string;
  origin: string;
}): Promise<boolean> {
  const issuer = await db.query.trustedIssuers.findFirst({
    where: eq(trustedIssuers.issuerUrl, input.issuerUrl),
    columns: { id: true },
  });
  if (!issuer) return false;
  const connection = await db.query.federatedApplicationConnections.findFirst({
    where: and(
      eq(federatedApplicationConnections.issuerId, issuer.id),
      eq(federatedApplicationConnections.clientId, input.clientId),
      eq(federatedApplicationConnections.status, "approved")
    ),
    columns: { allowedOrigins: true },
  });
  return Boolean(connection?.allowedOrigins.includes(input.origin));
}

function reviewShape(
  request: NonNullable<
    Awaited<ReturnType<FederatedApplicationConnectionService["getRequest"]>>
  >,
  canReview: boolean,
  options?: { matchingApprovedConnection?: boolean }
) {
  const effectiveStatus = effectiveRequestStatus(
    request.status,
    request.expiresAt
  );
  const matching = options?.matchingApprovedConnection === true && canReview;
  if (!canReview) {
    // The opaque callback and exact issuer/origin pair are an owner review
    // artifact. A requester or ordinary member only needs the current state
    // and clear owner guidance, not a reconnaissance view of every pending
    // external application registration on the Pod.
    return {
      id: request.id,
      issuerUrl: "Visible to Pod owners and administrators",
      clientId: "Visible to Pod owners and administrators",
      displayName: "An application",
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
  };
}

export const applicationConnectionsRouter = router({
  /**
   * The browser reached this Pod-owned route through a public, non-authorizing
   * handoff. Redeem it only after Pod Admin's local Kratos session exists;
   * this is what binds the later review request to a real Pod user.
   */
  redeemRequest: protectedProcedure
    .input(redeemRequestSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const request = await connectionService.redeemRequest({
          requestId: input.requestId,
          redemptionHash: hashOpaqueApplicationConnectionValue(
            input.redemptionSecret
          ),
          requestedByUserId: ctx.userId,
        });
        return { requestId: request.id };
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
      const matching =
        canReview &&
        (await matchingApprovedConnection({
          issuerUrl: request.issuerUrl,
          clientId: request.clientId,
          origin: request.requestedOrigin,
        }));
      return reviewShape(request, canReview, {
        matchingApprovedConnection: matching,
      });
    }),

  list: podAdminProcedure.query(async () => {
    const [connectionRows, requests] = await Promise.all([
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
    ]);
    return {
      connections: connectionRows.map(({ connection, issuerUrl }) => ({
        ...connection,
        issuerUrl,
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

  approveRequest: podAdminProcedure
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
      try {
        await connectionService.reject({
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
        .returning({ id: federatedApplicationConnections.id });
      if (!revoked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Application connection not found",
        });
      }
      // Deliberately do not revoke the issuer here: it may serve another
      // approved client or Pod integration. Revocation immediately removes
      // this browser origin's CORS/admission route. It intentionally neither
      // changes local memberships nor invalidates a generic Pod session that
      // the person can still use directly until its ordinary expiry.
    }),
});
