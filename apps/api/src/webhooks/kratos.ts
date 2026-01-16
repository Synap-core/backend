/**
 * Kratos Webhook Handler
 *
 * Receives webhooks from Ory Kratos when identities are created/updated
 * Syncs user data to Synap database and creates default workspaces
 */

import { Hono } from "hono";
import { syncUserFromKratos, createDefaultWorkspace } from "@synap/api";
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
      secret ? "${secret.substring(0,4)}..." : "undefined"
    );
    console.log(
      "[Webhook Debug] Expected:",
      expectedSecret ? "${expectedSecret.substring(0,4)}..." : "undefined"
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

    // Handle identity.created event
    if (event.type === "identity.created" && event.identity) {
      const identityId = event.identity.id;
      const traits = event.identity.traits || {};

      // Sync user to database
      await syncUserFromKratos(identityId);

      // Create default workspace for new user
      await createDefaultWorkspace(identityId, traits);

      logger.info(
        { identityId },
        "Successfully processed identity.created event"
      );
    }

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

    return c.json({ success: true });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to process Kratos webhook");
    return c.json(
      {
        error: "Internal server error",
        message: error.message,
      },
      500
    );
  }
});
