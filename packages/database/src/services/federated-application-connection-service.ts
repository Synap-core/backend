/**
 * Pod-owned application-connection ledger.
 *
 * This service intentionally knows nothing about a Control Plane. It stores
 * the Pod owner's review of an issuer + browser client pairing and keeps the
 * opaque browser continuation/callback material hashed at rest.
 */

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import {
  federatedApplicationConnectionRequests,
  federatedApplicationConnections,
} from "../schema/federation.js";
import { trustedIssuers } from "../schema/trusted-issuers.js";
import type { FederatedApplicationConnectionScope } from "../schema/federation.js";

export type CreateFederatedApplicationConnectionRequestInput = {
  issuerUrl: string;
  clientId: string;
  displayName: string;
  publisherUrl?: string | null;
  requestedOrigin: string;
  requestedCallbackUrl: string;
  requestedScopes: FederatedApplicationConnectionScope[];
  continuationHash: string;
  requestedByUserId: string;
  expiresAt: Date;
  requestMetadata?: Record<string, unknown>;
};

export type ApproveFederatedApplicationConnectionRequestInput = {
  requestId: string;
  reviewerUserId: string;
  callbackCodeHash: string;
};

export class FederatedApplicationConnectionService {
  async createPending(input: CreateFederatedApplicationConnectionRequestInput) {
    const [created] = await db
      .insert(federatedApplicationConnectionRequests)
      .values({
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        displayName: input.displayName,
        publisherUrl: input.publisherUrl ?? null,
        requestedOrigin: input.requestedOrigin,
        requestedCallbackUrl: input.requestedCallbackUrl,
        requestedScopes: input.requestedScopes,
        continuationHash: input.continuationHash,
        requestedByUserId: input.requestedByUserId,
        expiresAt: input.expiresAt,
        requestMetadata: input.requestMetadata ?? null,
      })
      .returning();
    if (!created) {
      throw new Error("Could not create application connection request");
    }
    return created;
  }

  async getRequest(requestId: string) {
    return (
      (await db.query.federatedApplicationConnectionRequests.findFirst({
        where: eq(federatedApplicationConnectionRequests.id, requestId),
      })) ?? null
    );
  }

  /**
   * Approve a pending request atomically. Requested federation scopes belong
   * only to the exact application connection; legacy issuer capabilities are
   * intentionally untouched. A connection never creates or widens a user's
   * Pod membership.
   */
  async approve(input: ApproveFederatedApplicationConnectionRequestInput) {
    const now = new Date();
    return db.transaction(async (tx) => {
      // This conditional transition is the concurrency guard: only one owner
      // can turn a pending, non-expired request into an approval.
      const [request] = await tx
        .update(federatedApplicationConnectionRequests)
        .set({
          status: "approved",
          reviewedBy: input.reviewerUserId,
          reviewedAt: now,
          callbackCodeHash: input.callbackCodeHash,
          callbackIssuedAt: now,
        })
        .where(
          and(
            eq(federatedApplicationConnectionRequests.id, input.requestId),
            eq(federatedApplicationConnectionRequests.status, "pending"),
            gt(federatedApplicationConnectionRequests.expiresAt, now)
          )
        )
        .returning();

      if (!request) {
        const existing =
          await tx.query.federatedApplicationConnectionRequests.findFirst({
            where: eq(
              federatedApplicationConnectionRequests.id,
              input.requestId
            ),
            columns: { status: true, expiresAt: true },
          });
        if (!existing)
          throw new Error("Application connection request not found");
        if (existing.expiresAt <= now || existing.status === "expired") {
          throw new Error("Application connection request has expired");
        }
        throw new Error(
          "Application connection request has already been reviewed"
        );
      }

      let issuer = await tx.query.trustedIssuers.findFirst({
        where: eq(trustedIssuers.issuerUrl, request.issuerUrl),
      });
      if (!issuer) {
        const [createdIssuer] = await tx
          .insert(trustedIssuers)
          .values({
            issuerUrl: request.issuerUrl,
            displayName: request.displayName,
            status: "approved",
            // App scopes belong only to the exact connection below. A browser
            // approval must never widen this issuer's legacy capabilities.
            allowedScopes: [],
            reviewedBy: input.reviewerUserId,
            reviewedAt: now,
            initialRequestData: {
              requestedVia: "application-connection",
              clientId: request.clientId,
            },
          })
          .onConflictDoNothing()
          .returning();
        issuer =
          createdIssuer ??
          (await tx.query.trustedIssuers.findFirst({
            where: eq(trustedIssuers.issuerUrl, request.issuerUrl),
          }));
      }
      if (!issuer) throw new Error("Could not register application issuer");
      if (issuer.status === "rejected" || issuer.status === "revoked") {
        throw new Error("This issuer has been rejected or revoked by the Pod");
      }

      if (issuer.status !== "approved") {
        const [approvedIssuer] = await tx
          .update(trustedIssuers)
          .set({
            status: "approved",
            reviewedBy: input.reviewerUserId,
            reviewedAt: now,
            rejectionReason: null,
            updatedAt: now,
          })
          .where(eq(trustedIssuers.id, issuer.id))
          .returning();
        if (!approvedIssuer)
          throw new Error("Could not approve application issuer");
        issuer = approvedIssuer;
      }

      const [connection] = await tx
        .insert(federatedApplicationConnections)
        .values({
          issuerId: issuer.id,
          clientId: request.clientId,
          displayName: request.displayName,
          publisherUrl: request.publisherUrl,
          allowedOrigins: [request.requestedOrigin],
          allowedCallbackUrls: [request.requestedCallbackUrl],
          allowedScopes: request.requestedScopes,
          status: "approved",
          reviewedBy: input.reviewerUserId,
          reviewedAt: now,
          initialRequestData: request.requestMetadata,
        })
        .onConflictDoUpdate({
          target: [
            federatedApplicationConnections.issuerId,
            federatedApplicationConnections.clientId,
          ],
          set: {
            displayName: request.displayName,
            publisherUrl: request.publisherUrl,
            // A later owner-approved request extends an *active* connection.
            // A revoked connection is different: a fresh review can re-enable
            // this issuer/client pair, but must replace every old endpoint and
            // scope instead of silently resurrecting revoked browser URLs.
            allowedOrigins: sql`CASE WHEN ${federatedApplicationConnections.status} = 'revoked' THEN EXCLUDED.allowed_origins ELSE ARRAY(SELECT DISTINCT UNNEST(${federatedApplicationConnections.allowedOrigins} || EXCLUDED.allowed_origins)) END`,
            allowedCallbackUrls: sql`CASE WHEN ${federatedApplicationConnections.status} = 'revoked' THEN EXCLUDED.allowed_callback_urls ELSE ARRAY(SELECT DISTINCT UNNEST(${federatedApplicationConnections.allowedCallbackUrls} || EXCLUDED.allowed_callback_urls)) END`,
            allowedScopes: sql`CASE WHEN ${federatedApplicationConnections.status} = 'revoked' THEN EXCLUDED.allowed_scopes ELSE ARRAY(SELECT DISTINCT UNNEST(${federatedApplicationConnections.allowedScopes} || EXCLUDED.allowed_scopes)) END`,
            status: "approved",
            reviewedBy: input.reviewerUserId,
            reviewedAt: now,
            rejectionReason: null,
            updatedAt: now,
          },
        })
        .returning();
      if (!connection)
        throw new Error("Could not approve application connection");

      const [linkedRequest] = await tx
        .update(federatedApplicationConnectionRequests)
        .set({ approvedConnectionId: connection.id })
        .where(eq(federatedApplicationConnectionRequests.id, request.id))
        .returning();
      if (!linkedRequest)
        throw new Error("Could not finalise application approval");

      return { request: linkedRequest, connection };
    });
  }

  async reject(input: {
    requestId: string;
    reviewerUserId: string;
    reason: string;
  }) {
    const now = new Date();
    const [updated] = await db
      .update(federatedApplicationConnectionRequests)
      .set({
        status: "rejected",
        reviewedBy: input.reviewerUserId,
        reviewedAt: now,
        decisionReason: input.reason,
      })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(federatedApplicationConnectionRequests.status, "pending"),
          gt(federatedApplicationConnectionRequests.expiresAt, now)
        )
      )
      .returning();
    if (!updated)
      throw new Error("Application connection request is no longer pending");
    return updated;
  }

  /**
   * Consume the two opaque browser values once. A caller can learn only the
   * decision for a request for which it already has the continuation secret.
   */
  async consumeCompletion(input: {
    requestId: string;
    continuationHash: string;
    callbackCodeHash: string;
  }) {
    const now = new Date();
    const [consumed] = await db
      .update(federatedApplicationConnectionRequests)
      .set({ callbackConsumedAt: now })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(federatedApplicationConnectionRequests.status, "approved"),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          eq(
            federatedApplicationConnectionRequests.callbackCodeHash,
            input.callbackCodeHash
          ),
          isNull(federatedApplicationConnectionRequests.callbackConsumedAt),
          gt(federatedApplicationConnectionRequests.expiresAt, now)
        )
      )
      .returning({ id: federatedApplicationConnectionRequests.id });
    return consumed ?? null;
  }

  /**
   * Read the minimal decision state for the app that holds the opaque
   * continuation. This deliberately returns no callback, user, issuer, or
   * connection detail, so request IDs never become a status oracle.
   */
  async getStatusForContinuation(input: {
    requestId: string;
    continuationHash: string;
  }): Promise<"pending" | "approved" | "rejected" | "expired" | null> {
    const request =
      await db.query.federatedApplicationConnectionRequests.findFirst({
        where: and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          )
        ),
        columns: { status: true, expiresAt: true },
      });
    if (!request) return null;
    if (request.expiresAt > new Date()) return request.status;
    if (request.status === "pending") {
      await db
        .update(federatedApplicationConnectionRequests)
        .set({ status: "expired" })
        .where(
          and(
            eq(federatedApplicationConnectionRequests.id, input.requestId),
            eq(
              federatedApplicationConnectionRequests.continuationHash,
              input.continuationHash
            ),
            eq(federatedApplicationConnectionRequests.status, "pending")
          )
        );
    }
    return "expired";
  }
}
