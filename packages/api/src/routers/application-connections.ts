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
  FederatedApplicationConnectionService,
  federatedApplicationConnections,
  trustedIssuers,
  workspaces,
} from "@synap/database";
import { router, podAdminProcedure, protectedProcedure } from "../trpc.js";
import {
  buildApplicationConnectionCallbackUrl,
  createOpaqueApplicationConnectionValue,
  hashOpaqueApplicationConnectionValue,
} from "../utils/application-connection.js";

const requestIdSchema = z.object({ requestId: z.string().uuid() });

const connectionService = new FederatedApplicationConnectionService();

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

function reviewShape(
  request: NonNullable<
    Awaited<ReturnType<FederatedApplicationConnectionService["getRequest"]>>
  >,
  canReview: boolean
) {
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
      status: request.status,
      decisionReason: request.decisionReason,
      expiresAt: request.expiresAt,
      reviewedAt: request.reviewedAt,
      canReview: false,
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
    status: request.status,
    decisionReason: request.decisionReason,
    expiresAt: request.expiresAt,
    reviewedAt: request.reviewedAt,
    canReview,
  };
}

export const applicationConnectionsRouter = router({
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
      return reviewShape(
        request,
        await canReviewPodApplicationConnections(ctx.userId)
      );
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
      requests,
    };
  }),

  approveRequest: podAdminProcedure
    .input(requestIdSchema)
    .mutation(async ({ input, ctx }) => {
      const callbackCode = createOpaqueApplicationConnectionValue();
      let approved: Awaited<
        ReturnType<FederatedApplicationConnectionService["approve"]>
      >;
      try {
        approved = await connectionService.approve({
          requestId: input.requestId,
          reviewerUserId: ctx.userId,
          callbackCodeHash: hashOpaqueApplicationConnectionValue(callbackCode),
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
        // This URL is constructed from the exact callback the owner just
        // reviewed. It includes a one-time opaque code, never a Pod credential.
        continuationUrl: buildApplicationConnectionCallbackUrl({
          callbackUrl: approved.request.requestedCallbackUrl,
          requestId: approved.request.id,
          code: callbackCode,
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
