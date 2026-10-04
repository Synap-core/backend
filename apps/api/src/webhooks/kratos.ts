/**
 * Kratos Webhook Handler
 *
 * Mounted at /api/webhooks/kratos (apps/api/src/index.ts).
 *
 *   POST /                       identity.updated sync (settings hook)
 *   POST /registration/gate      blocking registration gate (pre-persist)
 *   POST /registration/complete  Cloud owner claim (post-persist, oidc only)
 *   POST /settings/guard         Cloud-trust guard on credential changes (pre-persist)
 *   POST /login/cloud            Cloud sign-in gate (owner set Cloud trust "off")
 *
 * The registration routes live in `./kratos-registration-gate.ts`; the real
 * dependencies are wired below.
 */

import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { normalizeIssuerUrl, syncUserFromKratos } from "@synap/api";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { eq, getDb, TrustedIssuerService } from "@synap/database";
import { users } from "@synap/database/schema";
import {
  claimPodOwnerFromCloudSignIn,
  deleteKratosIdentity,
  hasDifferentHumanPodOwner,
  readFederationOidcIssuer,
} from "../routers/federation.js";
import { createRegistrationGateRouter } from "./kratos-registration-gate.js";
import { getKratosSession } from "@synap/auth";
import { createCloudTrustHookRouter } from "./kratos-cloud-trust.js";
import {
  findAccountByIdentity,
  kratosIdentityHasPodHeldCredential,
  readCloudTrust,
  recoveryCodeSummary,
} from "../routers/account-recovery-deps.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const logger = createLogger({ module: "kratos-webhook" });

export const kratosWebhookRouter = new Hono();

/**
 * Kratos webhook endpoint
 * POST /api/webhooks/kratos
 */
kratosWebhookRouter.post("/", async (c) => {
  try {
    // Verify webhook secret
    const secret = c.req.header("X-Webhook-Secret");
    const expectedSecret = process.env.KRATOS_WEBHOOK_SECRET;

    if (!expectedSecret) {
      logger.error("KRATOS_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook not configured" }, 500);
    }

    if (!secret || !safeCompare(secret, expectedSecret)) {
      logger.warn(
        {
          receivedLength: secret?.length,
          expectedLength: expectedSecret?.length,
        },
        "Invalid webhook secret received"
      );
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Parse webhook payload
    const event = await c.req.json();

    logger.info(
      { type: event.type, identityId: event.identity?.id },
      "Received Kratos webhook"
    );

    // Handle identity.updated event
    if (event.type === "identity.updated" && event.identity) {
      const identityId = event.identity.id;

      // Sync updated user data
      await syncUserFromKratos(identityId);

      await emitSideEffects({
        subjectType: "user",
        action: "updated",
        subjectId: identityId,
        userId: identityId,
      }).catch((err) =>
        logger.warn({ err }, "emitSideEffects failed (non-fatal)")
      );

      logger.info(
        { identityId },
        "Successfully processed identity.updated event"
      );
    }

    // Always return 200 to Kratos, even if webhook processing fails
    // This ensures registration/login doesn't fail due to webhook issues
    return c.json({ success: true });
  } catch (error: any) {
    // Log error but return 200 - don't block authentication
    logger.error({ err: error }, "Failed to process Kratos webhook");
    // Return 200 anyway - user authentication should succeed even if webhook fails
    return c.json({
      success: false, // Indicate failure in response body
      error: "Webhook processing failed but authentication succeeded",
      message: error.message,
    });
  }
});

function kratosAdminUrl(): string {
  return process.env.KRATOS_ADMIN_URL || "http://localhost:4434";
}

kratosWebhookRouter.route(
  "/registration",
  createRegistrationGateRouter({
    readFederationIssuer: readFederationOidcIssuer,
    normalizeIssuerUrl,
    async hasDifferentHumanOwner(issuerUrl, sub) {
      const issuer = await new TrustedIssuerService().getByUrl(issuerUrl);
      return hasDifferentHumanPodOwner(issuer?.id, sub);
    },
    async kratosEmailExists(email) {
      const res = await fetch(
        `${kratosAdminUrl()}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (!res.ok) {
        throw new Error(`Kratos admin identity lookup failed: ${res.status}`);
      }
      const identities = (await res.json()) as unknown;
      return Array.isArray(identities) && identities.length > 0;
    },
    async podUserExists(identityId) {
      const db = await getDb();
      const row = await db.query.users.findFirst({
        where: eq(users.id, identityId),
        columns: { id: true },
      });
      return Boolean(row);
    },
    claimOwner: claimPodOwnerFromCloudSignIn,
    deleteKratosIdentity: (identityId) =>
      deleteKratosIdentity(kratosAdminUrl(), identityId),
  })
);

kratosWebhookRouter.route(
  "/",
  createCloudTrustHookRouter({
    readCloudTrust,
    resolveSession: (cookieValue) =>
      getKratosSession(`ory_kratos_session=${cookieValue}`),
    async accountHasPodHeldFactor(identityId) {
      if (await kratosIdentityHasPodHeldCredential(identityId)) return true;
      const account = await findAccountByIdentity(identityId);
      if (!account) return false;
      return (await recoveryCodeSummary(account.userId)).remaining > 0;
    },
    logger,
  })
);
