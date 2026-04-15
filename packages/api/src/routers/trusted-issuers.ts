import { router, podAdminProcedure } from "../trpc.js";
import { z } from "zod";
import { TrustedIssuerService, db, eq, and } from "@synap/database";
import { API_KEY_SCOPES } from "@synap/database/schema";
import { apiKeys, trustedIssuers } from "@synap/database/schema";

export const trustedIssuersRouter = router({
  list: podAdminProcedure.query(async () => {
    const svc = new TrustedIssuerService();
    return svc.list();
  }),

  approve: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        allowedScopes: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
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
});
