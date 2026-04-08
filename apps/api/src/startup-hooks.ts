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
import { sql as drizzleSql } from "drizzle-orm";
import { setDynamicCorsOrigins } from "@synap/api";

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
 * Platform origins that every pod must allow so the Synap landing page and
 * developer dashboard (synap.dev) can reach the pod's tRPC from the browser.
 *
 * This runs once per pod lifecycle. If the origins are already present in
 * corsAllowedOrigins they are skipped — fully idempotent.
 */
const PLATFORM_CORS_ORIGINS = [
  "https://synap.dev",
  "https://www.synap.dev",
  "https://app.synap.live",
] as const;

async function seedDefaultCorsOrigins(): Promise<void> {
  try {
    const { workspaces } = await import("@synap/database/schema");
    const ws = await db.query.workspaces.findFirst({
      orderBy: (ws, { asc }) => [asc(ws.createdAt)],
    });
    if (!ws) return;

    const current: string[] = (ws.settings as any)?.corsAllowedOrigins ?? [];
    const toAdd = PLATFORM_CORS_ORIGINS.filter((o) => !current.includes(o));
    if (toAdd.length === 0) return; // Already seeded — nothing to do

    const merged = [...current, ...toAdd];
    await db
      .update(workspaces)
      .set({
        settings: drizzleSql`settings || ${JSON.stringify({ corsAllowedOrigins: merged })}::jsonb`,
      })
      .where(eq(workspaces.id, ws.id));

    logger.info({ added: toAdd }, "Seeded default platform CORS origins");
  } catch (err) {
    logger.warn({ err }, "Failed to seed default CORS origins (non-fatal)");
  }
}

/**
 * Load CORS allowed origins from the first workspace's settings into the in-memory cache.
 * Called at startup so dynamically configured origins are available immediately.
 */
async function loadCorsOrigins(): Promise<void> {
  try {
    const ws = await db.query.workspaces.findFirst({
      orderBy: (ws, { asc }) => [asc(ws.createdAt)],
    });
    const dbOrigins: string[] = (ws?.settings as any)?.corsAllowedOrigins ?? [];
    if (dbOrigins.length > 0) {
      const envOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
      setDynamicCorsOrigins([...new Set([...envOrigins, ...dbOrigins])]);
      logger.info(
        { count: dbOrigins.length },
        "Loaded CORS origins from workspace settings"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load CORS origins from DB (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Critical secrets validation — fail fast before accepting traffic
// ---------------------------------------------------------------------------

const REQUIRED_SECRETS: string[] = [
  "JWT_SECRET",
  "POSTGRES_PASSWORD",
  "SYNAP_SERVICE_ENCRYPTION_KEY",
  "KRATOS_SECRETS_COOKIE",
];

const RECOMMENDED_SECRETS: string[] = [
  "VAULT_SERVER_KEY",
  "HUB_PROTOCOL_API_KEY",
  "KRATOS_SECRETS_CIPHER",
];

function validateCriticalSecrets(): void {
  const missing = REQUIRED_SECRETS.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    logger.error(
      { missing },
      "FATAL: Required environment variables are not set. " +
        "The pod cannot start safely without these secrets. " +
        "Run install.sh to generate them, or set them manually in .env."
    );
    process.exit(1);
  }

  const missingRecommended = RECOMMENDED_SECRETS.filter(
    (key) => !process.env[key]?.trim()
  );
  if (missingRecommended.length > 0) {
    logger.warn(
      { missingRecommended },
      "Some optional but recommended secrets are not set. " +
        "Vault features and Hub Protocol may be unavailable."
    );
  }
}

/**
 * Run all startup hooks
 */
export async function runStartupHooks(): Promise<void> {
  logger.info("🚀 Running startup hooks...");

  // Validate critical secrets first — exits the process if any are missing
  validateCriticalSecrets();

  ensureChannelGatewayKey();
  await seedDefaultCorsOrigins(); // Ensure synap.dev can reach this pod
  await loadCorsOrigins();
  await configureN8NWebhook();
  await configureLangFlow();

  logger.info("✅ Startup hooks complete");
}
