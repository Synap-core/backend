/**
 * Pod-owned application-connection ledger.
 *
 * The lifecycle is deliberately generic: an issuer is a cryptographic
 * authority, a client is a browser application, and the Pod owns its local
 * user identity. No external federator or product account is persisted here.
 */

import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import {
  federatedApplicationConnectionRequests,
  federatedApplicationConnections,
} from "../schema/federation.js";
import { trustedIssuers } from "../schema/trusted-issuers.js";
import type {
  FederatedApplicationConnectionRequest,
  FederatedApplicationConnectionScope,
} from "../schema/federation.js";

export type CreateFederatedApplicationConnectionRequestInput = {
  /** Browser-generated public correlation id; the continuation remains secret. */
  requestId?: string;
  issuerUrl: string;
  issuerSubject: string;
  clientId: string;
  displayName: string;
  publisherUrl?: string | null;
  requestedOrigin: string;
  requestedCallbackUrl: string;
  requestedScopes: FederatedApplicationConnectionScope[];
  continuationHash: string;
  redemptionHash: string;
  expiresAt: Date;
  requestMetadata?: Record<string, unknown>;
};

export type ApproveFederatedApplicationConnectionRequestInput = {
  requestId: string;
  reviewerUserId: string;
};

export type ApplicationConnectionRequestStatus =
  | "awaiting_local_auth"
  | "pending"
  | "approved"
  | "completing"
  | "completed"
  | "rejected"
  | "expired";

function expiredStatus(
  status: ApplicationConnectionRequestStatus,
  expiresAt: Date
): ApplicationConnectionRequestStatus {
  // A decision is durable history, not an active handoff lease. In
  // particular, do not turn a rejected request into “expired” after its
  // handoff window: that would erase the owner’s explanation for the
  // requester and make status polling contradictory.
  if (status === "completed" || status === "rejected" || status === "expired") {
    return status;
  }
  return expiresAt > new Date() ? status : "expired";
}

export type ApplicationConnectionCompletion = {
  receiptId: string;
  expiresAt: Date;
};

export type ApplicationConnectionRequestStatusResult = {
  status: ApplicationConnectionRequestStatus;
  expiresAt: Date;
  completion: ApplicationConnectionCompletion | null;
};

const COMPLETION_LEASE_MS = 60_000;

export class FederatedApplicationConnectionService {
  /**
   * The selected Pod receives only the app proposal, a public request id, and
   * a hash of the requester-held continuation. It does not receive a Pod
   * credential or any external account identifier.
   */
  async createAwaitingLocalAuth(
    input: CreateFederatedApplicationConnectionRequestInput
  ) {
    if (!input.requestId) {
      throw new Error("Application connection request id is required");
    }
    const [created] = await db
      .insert(federatedApplicationConnectionRequests)
      .values({
        id: input.requestId,
        issuerUrl: input.issuerUrl,
        issuerSubject: input.issuerSubject,
        clientId: input.clientId,
        displayName: input.displayName,
        publisherUrl: input.publisherUrl ?? null,
        requestedOrigin: input.requestedOrigin,
        requestedCallbackUrl: input.requestedCallbackUrl,
        requestedScopes: input.requestedScopes,
        continuationHash: input.continuationHash,
        redemptionHash: input.redemptionHash,
        requestedByUserId: null,
        status: "awaiting_local_auth",
        expiresAt: input.expiresAt,
        requestMetadata: input.requestMetadata ?? null,
      })
      .returning();
    if (!created) {
      throw new Error("Could not start application connection request");
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
   * Pod Admin's native local session binds the requester. This is idempotent
   * for the same local user so a page refresh cannot strand the handoff.
   */
  async redeemRequest(input: {
    requestId: string;
    redemptionHash: string;
    requestedByUserId: string;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [redeemed] = await tx
        .update(federatedApplicationConnectionRequests)
        .set({
          requestedByUserId: input.requestedByUserId,
          status: "pending",
        })
        .where(
          and(
            eq(federatedApplicationConnectionRequests.id, input.requestId),
            eq(
              federatedApplicationConnectionRequests.status,
              "awaiting_local_auth"
            ),
            eq(
              federatedApplicationConnectionRequests.redemptionHash,
              input.redemptionHash
            ),
            gt(federatedApplicationConnectionRequests.expiresAt, now)
          )
        )
        .returning();
      if (redeemed) return redeemed;

      const existing =
        await tx.query.federatedApplicationConnectionRequests.findFirst({
          where: eq(federatedApplicationConnectionRequests.id, input.requestId),
          columns: {
            status: true,
            requestedByUserId: true,
            redemptionHash: true,
            expiresAt: true,
          },
        });
      if (!existing) {
        throw new Error("Application connection request was not found");
      }
      if (existing.redemptionHash !== input.redemptionHash) {
        throw new Error("Application connection request was not found");
      }
      if (existing.expiresAt <= now || existing.status === "expired") {
        throw new Error("Application connection request has expired");
      }
      if (
        existing.status === "pending" &&
        existing.requestedByUserId === input.requestedByUserId
      ) {
        const request =
          await tx.query.federatedApplicationConnectionRequests.findFirst({
            where: eq(
              federatedApplicationConnectionRequests.id,
              input.requestId
            ),
          });
        if (request) return request;
      }
      throw new Error(
        "Application connection request has already been redeemed"
      );
    });
  }

  /**
   * Approving changes only generic Pod trust state: the trusted issuer and the
   * exact browser client connection. It never creates a federated identity
   * link or a Pod membership for the reviewer.
   */
  async approve(input: ApproveFederatedApplicationConnectionRequestInput) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [request] = await tx
        .update(federatedApplicationConnectionRequests)
        .set({
          status: "approved",
          reviewedBy: input.reviewerUserId,
          reviewedAt: now,
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
        if (!existing) {
          throw new Error("Application connection request not found");
        }
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
            // Browser-client scopes are deliberately not issuer-wide.
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
   * Return the minimal state to the requester that holds the opaque
   * continuation. This is safe before an owner has approved the app origin.
   */
  async getStatusForContinuation(input: {
    requestId: string;
    continuationHash: string;
  }): Promise<ApplicationConnectionRequestStatusResult | null> {
    const request =
      await db.query.federatedApplicationConnectionRequests.findFirst({
        where: and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          )
        ),
        columns: {
          status: true,
          expiresAt: true,
          completionReceiptId: true,
          completionReceiptExpiresAt: true,
        },
      });
    if (!request) return null;
    const status = expiredStatus(request.status, request.expiresAt);
    if (status === "expired" && request.status !== "expired") {
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
            eq(federatedApplicationConnectionRequests.status, request.status)
          )
        );
    }
    const completion =
      status === "completed" &&
      request.completionReceiptId &&
      request.completionReceiptExpiresAt &&
      request.completionReceiptExpiresAt > new Date()
        ? {
            receiptId: request.completionReceiptId,
            expiresAt: request.completionReceiptExpiresAt,
          }
        : null;
    return { status, expiresAt: request.expiresAt, completion };
  }

  /**
   * The generic completion endpoint validates assertions before reserving.
   * A completed request whose short-lived receipt has expired can be renewed
   * while the requester-held continuation and the original request expiry are
   * still valid. Renewal never changes the Pod identity binding.
   */
  async getCompletableRequest(input: {
    requestId: string;
    continuationHash: string;
  }) {
    const request =
      await db.query.federatedApplicationConnectionRequests.findFirst({
        where: and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          or(
            and(
              eq(federatedApplicationConnectionRequests.status, "approved"),
              isNull(federatedApplicationConnectionRequests.completedAt)
            ),
            and(
              eq(federatedApplicationConnectionRequests.status, "completed"),
              lte(
                federatedApplicationConnectionRequests.completionReceiptExpiresAt,
                new Date()
              )
            )
          ),
          gt(federatedApplicationConnectionRequests.expiresAt, new Date())
        ),
      });
    if (!request?.requestedByUserId || !request.approvedConnectionId)
      return null;
    return request;
  }

  /**
   * Serialize the one receipt-minting section. A lost response remains
   * recoverable because a finalized receipt is stored on the request itself.
   */
  async recoverStaleCompletion(input: {
    requestId: string;
    continuationHash: string;
  }): Promise<boolean> {
    const staleBefore = new Date(Date.now() - COMPLETION_LEASE_MS);
    const [recovered] = await db
      .update(federatedApplicationConnectionRequests)
      .set({
        status: sql`CASE WHEN ${federatedApplicationConnectionRequests.completedAt} IS NULL THEN 'approved' ELSE 'completed' END`,
        completionStartedAt: null,
      })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          eq(federatedApplicationConnectionRequests.status, "completing"),
          lt(
            federatedApplicationConnectionRequests.completionStartedAt,
            staleBefore
          )
        )
      )
      .returning({ id: federatedApplicationConnectionRequests.id });
    return Boolean(recovered);
  }

  async reserveCompletion(input: {
    requestId: string;
    continuationHash: string;
  }): Promise<
    | { kind: "reserved"; request: FederatedApplicationConnectionRequest }
    | { kind: "completed"; completion: ApplicationConnectionCompletion }
    | null
  > {
    const now = new Date();
    // Completion performs only local database mutations after the assertion is
    // verified. Releasing a stale lease makes a crashed worker recoverable
    // without allowing parallel live completions.
    await this.recoverStaleCompletion(input);

    const [reserved] = await db
      .update(federatedApplicationConnectionRequests)
      .set({ status: "completing", completionStartedAt: now })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          or(
            and(
              eq(federatedApplicationConnectionRequests.status, "approved"),
              isNull(federatedApplicationConnectionRequests.completedAt)
            ),
            and(
              eq(federatedApplicationConnectionRequests.status, "completed"),
              lte(
                federatedApplicationConnectionRequests.completionReceiptExpiresAt,
                now
              )
            )
          ),
          gt(federatedApplicationConnectionRequests.expiresAt, now)
        )
      )
      .returning();
    if (reserved) return { kind: "reserved", request: reserved };

    const completed =
      await db.query.federatedApplicationConnectionRequests.findFirst({
        where: and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          eq(federatedApplicationConnectionRequests.status, "completed")
        ),
        columns: {
          completionReceiptId: true,
          completionReceiptExpiresAt: true,
        },
      });
    if (
      completed?.completionReceiptId &&
      completed.completionReceiptExpiresAt &&
      completed.completionReceiptExpiresAt > now
    ) {
      return {
        kind: "completed",
        completion: {
          receiptId: completed.completionReceiptId,
          expiresAt: completed.completionReceiptExpiresAt,
        },
      };
    }
    return null;
  }

  async finalizeCompletion(input: {
    requestId: string;
    continuationHash: string;
    completion: ApplicationConnectionCompletion;
  }) {
    const [completed] = await db
      .update(federatedApplicationConnectionRequests)
      .set({
        status: "completed",
        completedAt: new Date(),
        completionReceiptId: input.completion.receiptId,
        completionReceiptExpiresAt: input.completion.expiresAt,
      })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          eq(federatedApplicationConnectionRequests.status, "completing")
        )
      )
      .returning({ id: federatedApplicationConnectionRequests.id });
    return completed ?? null;
  }

  async releaseCompletion(input: {
    requestId: string;
    continuationHash: string;
  }) {
    await db
      .update(federatedApplicationConnectionRequests)
      .set({
        status: sql`CASE WHEN ${federatedApplicationConnectionRequests.completedAt} IS NULL THEN 'approved' ELSE 'completed' END`,
        completionStartedAt: null,
      })
      .where(
        and(
          eq(federatedApplicationConnectionRequests.id, input.requestId),
          eq(
            federatedApplicationConnectionRequests.continuationHash,
            input.continuationHash
          ),
          eq(federatedApplicationConnectionRequests.status, "completing"),
          isNull(federatedApplicationConnectionRequests.completedAt)
        )
      );
  }
}
