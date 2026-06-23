/**
 * Startup Hooks - Auto-configuration on Server Start
 *
 * Handles automatic setup from environment variables:
 * - N8N webhook subscription
 * - LangFlow configuration
 * - Default integrations
 */

import { createLogger, config } from "@synap-core/core";
import {
  db,
  webhookSubscriptions,
  eq,
  and,
  inArray,
  ensureSystemProfiles,
  users,
  workspaces,
  workspaceMembers,
  apiKeys,
} from "@synap/database";
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

// In LOCAL_MODE, Kratos is not running — its cookie secret is irrelevant.
// We keep the list dynamic so the check remains a single function.
const REQUIRED_SECRETS_ALL: string[] = [
  "JWT_SECRET",
  // POSTGRES_PASSWORD is NOT checked here — it's interpolated into DATABASE_URL
  // by docker-compose and not passed as a separate env var to the container.
  "SYNAP_SERVICE_ENCRYPTION_KEY",
  "KRATOS_SECRETS_COOKIE",
];

const REQUIRED_SECRETS_LOCAL_MODE: string[] = [
  "JWT_SECRET",
  "SYNAP_SERVICE_ENCRYPTION_KEY",
  // KRATOS_SECRETS_COOKIE intentionally omitted — Kratos is not used in local mode
];

const RECOMMENDED_SECRETS: string[] = [
  "VAULT_SERVER_KEY",
  "HUB_PROTOCOL_API_KEY",
  "KRATOS_SECRETS_CIPHER",
];

function validateCriticalSecrets(): void {
  // CI smoke tests set this to skip secret validation — they only verify the image starts.
  if (process.env.SKIP_SECRET_VALIDATION === "true") {
    logger.warn(
      "SKIP_SECRET_VALIDATION is set — skipping critical secrets check (CI smoke test)"
    );
    return;
  }

  const REQUIRED_SECRETS = config.server.localMode
    ? REQUIRED_SECRETS_LOCAL_MODE
    : REQUIRED_SECRETS_ALL;

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
 * Pod-admin invariant check.
 *
 * The pod-admin invariant: there exists a `workspaces` row with
 * `settings->>'systemSlug' = 'pod-admin'` AND at least one
 * `workspace_members` row with role in (owner, admin) for that workspace.
 *
 * Without this, every `podAdminProcedure` returns 403 — operators sign in
 * but find every admin surface gated as "access required". Most common cause
 * is partial-state data loss (kratos identities survive, synap rows wiped),
 * which the previous `createAdminUser` could not repair on rerun.
 *
 * This check is **non-fatal**: a fresh install legitimately has no admin
 * yet (the first admin gets created in the install or bootstrap step). We
 * surface a structured warning the operator can follow to recover, and
 * record the state on a globally readable signal for the doctor route.
 */
let podAdminInvariantState: {
  healthy: boolean;
  reason: string;
  checkedAt: number;
} = { healthy: false, reason: "not yet checked", checkedAt: 0 };

export function getPodAdminInvariantState(): typeof podAdminInvariantState {
  return podAdminInvariantState;
}

export async function verifyPodAdminInvariant(): Promise<void> {
  try {
    const podAdminWorkspace = await db.query.workspaces.findFirst({
      where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
      columns: { id: true },
    });

    if (!podAdminWorkspace) {
      // No workspace at all → check whether ANY users exist. If there are
      // users but no pod-admin workspace, this is a real broken state. If
      // there are zero users, this is a legitimate fresh install pre-bootstrap.
      const anyUser = await db.query.users.findFirst({ columns: { id: true } });
      if (!anyUser) {
        podAdminInvariantState = {
          healthy: false,
          reason: "no users yet — pre-bootstrap install",
          checkedAt: Date.now(),
        };
        logger.info("Pod-admin invariant: pre-bootstrap (no users yet)");
        return;
      }
      podAdminInvariantState = {
        healthy: false,
        reason: "users exist but no pod-admin system workspace",
        checkedAt: Date.now(),
      };
      logger.error(
        "⚠️  Pod-admin invariant BROKEN: users exist but no pod-admin workspace.\n" +
          "    Recovery: ADMIN_EMAIL=<your-email> ADMIN_PASSWORD=<password> \\\n" +
          "              pnpm tsx scripts/create-admin-cli.ts\n" +
          "    Or via the synap CLI:\n" +
          "              synap setup admin --email <your-email> --password <password>"
      );
      return;
    }

    const owners = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        inArray(workspaceMembers.role, ["owner", "admin"])
      ),
      columns: { userId: true },
    });

    if (!owners) {
      podAdminInvariantState = {
        healthy: false,
        reason: `pod-admin workspace ${podAdminWorkspace.id} exists but has no owner/admin member`,
        checkedAt: Date.now(),
      };
      logger.error(
        "⚠️  Pod-admin invariant BROKEN: pod-admin workspace exists but has no owners.\n" +
          "    Recovery: synap setup admin --email <your-email> --password <password>"
      );
      return;
    }

    // Check the user actually has a `users` row matching the membership.
    // This catches the "kratos identity exists, synap users wiped" case.
    const userRow = await db.query.users.findFirst({
      where: eq(users.id, owners.userId),
      columns: { id: true, email: true },
    });

    if (!userRow) {
      podAdminInvariantState = {
        healthy: false,
        reason: `pod-admin owner ${owners.userId} has no users row (orphan membership)`,
        checkedAt: Date.now(),
      };
      logger.error(
        "⚠️  Pod-admin invariant BROKEN: orphan workspace_members row references missing user.\n" +
          "    The synap users table appears to have been wiped while keeping " +
          "Kratos identities and workspace_members.\n" +
          "    Recovery: synap setup admin --email <your-email> --password <password>"
      );
      return;
    }

    podAdminInvariantState = {
      healthy: true,
      reason: `pod-admin owned by ${userRow.email}`,
      checkedAt: Date.now(),
    };
    logger.info(
      { adminEmail: userRow.email, workspaceId: podAdminWorkspace.id },
      "Pod-admin invariant: healthy"
    );
  } catch (err) {
    podAdminInvariantState = {
      healthy: false,
      reason: `check failed: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt: Date.now(),
    };
    logger.warn(
      { err },
      "Pod-admin invariant check failed (non-fatal — will retry next boot)"
    );
  }
}

/**
 * Ensure the local operator user and a personal workspace exist in local mode.
 *
 * Uses the same idempotent `seedAdminUser` path as the normal handshake flow,
 * keyed on the stable LOCAL_USER_ID constant. Safe to call on every boot.
 */
async function ensureLocalUser(): Promise<void> {
  if (!config.server.localMode) return;

  try {
    const { LOCAL_USER_ID } = await import("@synap/auth");
    const { seedAdminUser } = await import("@synap/database");
    const result = await seedAdminUser({
      kratosIdentityId: LOCAL_USER_ID,
      email: "operator@local",
      name: "Local Operator",
      emailVerified: true,
    });
    logger.info(
      {
        userId: LOCAL_USER_ID,
        workspaceId: result.workspaceId,
        alreadyExisted: result.alreadyExisted,
      },
      "Local mode: operator user ensured"
    );
  } catch (err) {
    // Fatal in local mode — without a user row the pod cannot serve any request.
    logger.error(
      { err },
      "Local mode: failed to ensure operator user row — aborting"
    );
    process.exit(1);
  }
}

/**
 * Run all startup hooks
 */
/**
 * Self-heal the keystone: ensure the trusted Intelligence-Service pod key is
 * keyType "is_internal" so the X-Delegated-Operator-Id delegation gate fires.
 *
 * The IS key (hub_id="intelligence-hub-primary", owned by `system`) may have
 * been minted BEFORE the keystone existed → an old keyType → the delegation
 * gate never fires → the agent reads as the IS service identity instead of the
 * operator floor ("0 entities"). This UPDATES it IN PLACE — no key rotation
 * (same hash/scope; only the keyType discriminator changes), idempotent, every
 * boot. Targets ONLY the one trusted IS key, never arbitrary keys.
 */
const IS_HUB_ID = "intelligence-hub-primary";
export async function ensureISKeyIsInternal(): Promise<void> {
  try {
    const healed = await db
      .update(apiKeys)
      .set({ keyType: "is_internal" })
      .where(
        and(
          eq(apiKeys.hubId, IS_HUB_ID),
          drizzleSql`${apiKeys.keyType} <> 'is_internal'`
        )
      )
      .returning({ id: apiKeys.id });
    if (healed.length > 0) {
      logger.info(
        { count: healed.length },
        "✅ Self-healed IS key → keyType=is_internal (keystone operator-floor delegation now active)"
      );
    } else {
      logger.debug("IS key keyType already is_internal — no self-heal needed");
    }
  } catch (error) {
    logger.error({ error }, "❌ Failed to self-heal IS key keyType");
  }
}

export async function runStartupHooks(): Promise<void> {
  logger.info("🚀 Running startup hooks...");

  // Validate critical secrets first — exits the process if any are missing
  validateCriticalSecrets();

  ensureChannelGatewayKey();
  await seedDefaultCorsOrigins(); // Ensure synap.dev can reach this pod
  await loadCorsOrigins();
  // Keystone self-heal first — ensures the IS key is is_internal so the agent
  // reads the operator floor (not the empty service identity).
  await ensureISKeyIsInternal();
  await configureN8NWebhook();
  await configureLangFlow();

  // Seed system profiles and property definitions on every startup.
  // This is idempotent — it only creates what's missing.
  // Ensures existing installations pick up new property defs added in code updates.
  try {
    const result = await ensureSystemProfiles();
    logger.info({ ...result }, "System profiles seeded on startup");
  } catch (err) {
    logger.warn(
      { err },
      "Failed to seed system profiles on startup (non-fatal)"
    );
  }

  // Trusted issuers are established at provisioning time via POST /api/provision/seed-trust
  // (authenticated with PROVISIONING_TOKEN). No startup seeding — the pod starts with zero
  // knowledge of the CP URL. Trust is purely provisioning-driven.

  // LOCAL MODE: ensure the operator user + personal workspace exist in the DB.
  // Must run before verifyPodAdminInvariant so the invariant check sees a user.
  await ensureLocalUser();

  // Pod-admin invariant — non-fatal, surfaces a loud warning if broken so
  // operators see exactly which recovery command to run.
  await verifyPodAdminInvariant();

  logger.info("✅ Startup hooks complete");
}
