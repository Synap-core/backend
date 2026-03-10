/**
 * Startup Hooks - Auto-configuration on Server Start
 *
 * Handles automatic setup from environment variables:
 * - N8N webhook subscription
 * - LangFlow configuration
 * - Default integrations
 */

import { createLogger } from "@synap-core/core";
import { db, webhookSubscriptions, eq } from "@synap/database";
import { randomUUID, randomBytes } from "crypto";

const logger = createLogger({ module: "startup-hooks" });

/**
 * Auto-subscribe N8N webhook from environment variables
 */
export async function configureN8NWebhook(): Promise<void> {
  const n8nUrl = process.env.N8N_WEBHOOK_URL?.trim();

  if (!n8nUrl) {
    logger.debug("N8N_WEBHOOK_URL not set - skipping auto-configuration");
    return;
  }

  logger.info({ url: n8nUrl }, "Configuring N8N webhook from environment...");

  try {
    // Parse event types from env
    const eventTypesStr =
      process.env.N8N_EVENT_TYPES ||
      "entities.create.validated,entities.update.validated,entities.delete.validated";
    const eventTypes = eventTypesStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const secret = process.env.N8N_WEBHOOK_SECRET || randomUUID();

    // Check if subscription already exists
    const existing = await db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.url, n8nUrl))
      .limit(1);

    if (existing.length > 0) {
      // Update existing subscription
      await db
        .update(webhookSubscriptions)
        .set({
          eventTypes,
          secret,
          active: true,
          // updatedAt removed - managed by database
        })
        .where(eq(webhookSubscriptions.id, existing[0].id));

      logger.info(
        { id: existing[0].id },
        "✅ Updated existing N8N webhook subscription"
      );
    } else {
      // Create new subscription
      const result = await db
        .insert(webhookSubscriptions)
        .values({
          userId: "system", // System-level subscription
          name: "N8N Integration (Auto-configured)",
          url: n8nUrl,
          eventTypes,
          secret,
          // description removed - not in schema
          active: true,
          // createdAt/updatedAt removed - managed by database
        })
        .returning();

      logger.info(
        { id: result[0].id, eventTypes },
        "✅ Created N8N webhook subscription"
      );
    }

    logger.info(
      "🎉 N8N integration ready - events will be delivered to " + n8nUrl
    );
  } catch (error) {
    logger.error({ error }, "❌ Failed to configure N8N webhook");
    // Don't throw - allow server to start even if configuration fails
  }
}

/**
 * Configure LangFlow integration
 */
export async function configureLangFlow(): Promise<void> {
  const langflowUrl = process.env.LANGFLOW_URL?.trim();

  if (!langflowUrl) {
    logger.debug("LANGFLOW_URL not set - skipping");
    return;
  }

  logger.info({ url: langflowUrl }, "🤖 LangFlow configured");
  // TODO: Add LangFlow-specific setup when ready
}

/**
 * Auto-generate CHANNEL_GATEWAY_KEY if not set.
 *
 * The key is stored in process.env so both the REST handler
 * and the channel-gateway service can read it. In production
 * users should pre-set this via environment/docker-compose;
 * this auto-generation covers dev/local setups.
 */
function ensureChannelGatewayKey(): void {
  if (process.env.CHANNEL_GATEWAY_KEY) return;

  const generated = randomBytes(32).toString("hex");
  process.env.CHANNEL_GATEWAY_KEY = generated;
  logger.warn(
    "CHANNEL_GATEWAY_KEY was not set — auto-generated for this session. " +
      "Set it in your environment for production use."
  );
}

/**
 * Run all startup hooks
 */
export async function runStartupHooks(): Promise<void> {
  logger.info("🚀 Running startup hooks...");

  ensureChannelGatewayKey();
  await configureN8NWebhook();
  await configureLangFlow();

  logger.info("✅ Startup hooks complete");
}
