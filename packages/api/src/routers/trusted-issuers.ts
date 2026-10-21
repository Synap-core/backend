import { router, podAdminProcedure, refuseDeviceSession } from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { TrustedIssuerService, db, eq, and } from "@synap/database";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { apiKeys, trustedIssuers } from "@synap/database/schema";
import { trustedIssuerCapabilitiesSchema } from "./trusted-issuer-capabilities.js";
import { normalizeIssuerUrl } from "../utils/issuer-url-safety.js";
import { readBrokerTrustDiagnostics } from "../connectors/broker-trust-diagnostics.js";

export const trustedIssuersRouter = router({
  list: podAdminProcedure.query(async () => {
    const svc = new TrustedIssuerService();
    return svc.list();
  }),

  /** Non-secret broker trust diagnostics (same reader as the Hub REST door). */
  brokerDiagnostics: podAdminProcedure.query(async () =>
    readBrokerTrustDiagnostics()
  ),

  /**
   * Approve an issuer, only from the status the person saw (`expectedStatus`,
   * default `pending`) — so a stale screen cannot resurrect a rejected or
   * revoked issuer. `approved` changes an approved issuer's scopes (the broker
   * panel's scope fix); `rejected` / `revoked` reinstate on purpose.
   * CONFLICT when the status moved, NOT_FOUND when there is no such issuer.
   */
  approve: podAdminProcedure
    .use(refuseDeviceSession)
    .input(
      z.object({
        id: z.string().uuid(),
        allowedScopes: trustedIssuerCapabilitiesSchema,
        expectedStatus: z
          .enum(["pending", "approved", "rejected", "revoked"])
          .default("pending"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const svc = new TrustedIssuerService();
      const approved = await svc.approveFromStatus(
        input.id,
        ctx.userId,
        input.allowedScopes,
        input.expectedStatus
      );
      if (approved) return approved;
      const current = await db.query.trustedIssuers.findFirst({
        where: eq(trustedIssuers.id, input.id),
        columns: { status: true },
      });
      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Trusted issuer not found",
        });
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: `This issuer is ${current.status} now, not ${input.expectedStatus}. Reload and decide again.`,
      });
    }),

  reject: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const svc = new TrustedIssuerService();
      await svc.reject(input.id, ctx.userId, input.reason);
    }),

  revoke: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const svc = new TrustedIssuerService();
      const issuer = await db.query.trustedIssuers.findFirst({
        where: eq(trustedIssuers.id, input.id),
        columns: { issuerUrl: true, status: true },
      });
      if (!issuer) {
        throw new Error(`Trusted issuer ${input.id} not found`);
      }
      await svc.revoke(input.id, ctx.userId);

      // Immediately revoke issuer-bound integration keys so access is cut off now.
      const issuerHost = new URL(issuer.issuerUrl).hostname;
      await revokeApiKeys(db, {
        where: and(
          eq(apiKeys.hubId, `integration:${issuerHost}`),
          eq(apiKeys.isActive, true)
        ),
        revokedBy: ctx.userId,
        reason: `Issuer revoked: ${issuer.issuerUrl}`,
      });
    }),

  adminRegister: podAdminProcedure
    .use(refuseDeviceSession)
    .input(
      z.object({
        issuerUrl: z.string().url(),
        displayName: z.string().min(1).max(100),
        allowedScopes: trustedIssuerCapabilitiesSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const issuerUrl = normalizeIssuerUrl(input.issuerUrl);
      if (!issuerUrl || issuerUrl !== input.issuerUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "issuerUrl must be a canonical HTTPS URL without credentials, query, fragment, or a trailing slash",
        });
      }

      const svc = new TrustedIssuerService();

      // Check if already registered (any status)
      const existing = await svc.getByUrl(issuerUrl);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `An issuer for ${issuerUrl} already exists (status: ${existing.status})`,
        });
      }

      // Insert directly as approved — admin-initiated, no pending step needed
      const pending = await svc.registerPending(
        issuerUrl,
        input.displayName,
        null
      );
      const approved = await svc.approvePending(
        pending.id,
        ctx.userId,
        input.allowedScopes
      );
      if (!approved) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The issuer for ${issuerUrl} was decided while it was being added`,
        });
      }
      return approved;
    }),
});
