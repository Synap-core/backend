import { router, podAdminProcedure } from "../trpc.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { TrustedIssuerService, db, eq, and } from "@synap/database";
import { apiKeys, trustedIssuers } from "@synap/database/schema";
import { trustedIssuerCapabilitiesSchema } from "./trusted-issuer-capabilities.js";
import { normalizeIssuerUrl } from "../utils/issuer-url-safety.js";

export const trustedIssuersRouter = router({
  list: podAdminProcedure.query(async () => {
    const svc = new TrustedIssuerService();
    return svc.list();
  }),

  approve: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        allowedScopes: trustedIssuerCapabilitiesSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const svc = new TrustedIssuerService();
      return svc.approve(input.id, ctx.userId, input.allowedScopes);
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
      await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedBy: ctx.userId,
          revokedReason: `Issuer revoked: ${issuer.issuerUrl}`,
        })
        .where(
          and(
            eq(apiKeys.hubId, `integration:${issuerHost}`),
            eq(apiKeys.isActive, true)
          )
        );
    }),

  adminRegister: podAdminProcedure
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
      const approved = await svc.approve(
        pending.id,
        ctx.userId,
        input.allowedScopes
      );
      return approved;
    }),
});
