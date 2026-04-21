/**
 * Kratos Webhook Handler
 *
 * Receives webhooks from Ory Kratos for identity.updated events only.
 * identity.created events only fire for self-service registration flows,
 * which we do not use — admin-API creates (seed-admin) don't trigger
 * webhooks. Identity seeding is handled synchronously by seed-admin.
 */

import { Hono } from "hono";
import { syncUserFromKratos } from "@synap/api";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "kratos-webhook" });

export const kratosWebhookRouter = new Hono();

/**
 * Kratos webhook endpoint
 * POST /webhooks/kratos
 */
kratosWebhookRouter.post("/", async (c) => {
  try {
    // Verify webhook secret
    const secret = c.req.header("X-Webhook-Secret");
    const expectedSecret = process.env.KRATOS_WEBHOOK_SECRET;

    console.log(
      "[Webhook Debug] Received:",
      secret ? `${secret.substring(0, 4)}...` : "undefined"
    );
    console.log(
      "[Webhook Debug] Expected:",
      expectedSecret ? `${expectedSecret.substring(0, 4)}...` : "undefined"
    );

    if (!expectedSecret) {
      logger.error("KRATOS_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook not configured" }, 500);
    }

    if (secret !== expectedSecret) {
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
