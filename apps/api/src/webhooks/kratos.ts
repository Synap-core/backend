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

    // Handle identity.created event
    if (event.type === "identity.created" && event.identity) {
      const identityId = event.identity.id;
      const traits = event.identity.traits || {};
      const email = traits.email as string;

      // Sync user to database
      await syncUserFromKratos(identityId);

      try {
        // Create/join workspace (returns workspace + role)
        // Security: Only allows if user has pending invite OR is admin
        const { id: workspaceId, role } = await createDefaultWorkspace(
          identityId,
          traits
        );

        logger.info(
          { identityId, workspaceId, role, email },
          "Successfully processed identity.created event"
        );
      } catch (error: any) {
        // Registration rejected due to security check
        // IMPORTANT: Always return 200 to Kratos - user account is created regardless
        // Webhook failures should not block registration
        logger.warn(
          { identityId, email, error: error.message },
          "Registration rejected: No invite and not admin"
        );
        // Note: User account is still created in Kratos, but they won't have workspace access
        // This is acceptable - they can contact admin to get invited
        // We return 200 anyway so Kratos doesn't fail the registration
      }
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
