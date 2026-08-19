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
  ensureTeamMemberRoleProfile,
  users,
  workspaces,
  workspaceMembers,
  TrustedIssuerService,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";
import { randomUUID, randomBytes } from "crypto";
import { sql as drizzleSql } from "drizzle-orm";
import {
  setDynamicCorsOrigins,
  ensureSynapCoreCapability,
  ensureSystemSkills,
  ensureCaptureAgent,
  reconcileCapabilitiesToTemplates,
  reconcileStandaloneConfigsToTemplates,
  backfillCapabilityEmits,
  notifyCapabilityUpdatesAvailable,
  normalizeIssuerUrl,
  fetchFederationMetadata,
  seedWidgetDefinitions,
} from "@synap/api";
import { reconcileWorkspacesToTemplates } from "./startup/reconcile-workspaces-to-templates.js";
import { backfillAllWorkspacesTeamPersonBridge } from "./startup/backfill-team-person-bridge.js";
import { backfillFederationOidcCredentials } from "./routers/federation.js";

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

/** Canonical bootstrap scopes granted to the CP as a trusted issuer. */
const CP_BOOTSTRAP_SCOPES = [
  TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
  TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
  TRUSTED_ISSUER_CAPABILITIES.MEMBERSHIP_GRANT,
  TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE,
];

/**
 * Seed the Control Plane as a built-in trusted issuer.
 *
 * Without this, a self-hosted pod never auto-trusts the CP: federated sign-in
 * only works if the issuer happened to be provisioned by luck.
 *
 * The CP's federation issuer identity is DELIBERATELY independent from the
 * pod's CONTROL_PLANE_URL (its outbound transport URL): the CP signs assertions
 * with `getControlPlaneIssuerUrl()` (CP_ISSUER_URL / api.${APP_DOMAIN}), which
 * legitimately differs under multi-region / custom-domain / internal-hostname /
 * self-hosted-split deployments. So we DISCOVER the declared issuer by fetching
 * `${CONTROL_PLANE_URL}/federation/metadata` over the SSRF-safe client and seed
 * THAT `iss` (plus the CP's declared scopes). On ANY failure — fetch error,
 * non-2xx, malformed body, or a CP too old to serve the endpoint — we fall back
 * to the historical behavior: derive the issuer from CONTROL_PLANE_URL and use
 * the hardcoded bootstrap scope set. We do NOT require issuer == transport
 * origin; decoupling them is the whole point.
 *
 * Skipped silently when CONTROL_PLANE_URL is unset — a self-hosted pod with no
 * Control Plane is a legitimate configuration. Idempotent (`seedBuiltIn` only
 * adds missing built-in scopes, never removes operator-approved ones) and
 * non-fatal, exactly like the neighbouring seedDefaultCorsOrigins hook.
 */
async function seedControlPlaneIssuer(): Promise<void> {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!controlPlaneUrl) return; // self-hosted without a CP — nothing to trust

  try {
    // Prefer the CP-DECLARED issuer (transport URL may differ from signing iss).
    let issuerUrl: string | null = null;
    let allowedScopes: string[] = CP_BOOTSTRAP_SCOPES;
    let source: "declared" | "transport" = "declared";

    try {
      const metadata = await fetchFederationMetadata(controlPlaneUrl);
      issuerUrl = metadata.issuer;
      allowedScopes = metadata.scopes;
    } catch (discoveryErr) {
      // CP too old, unreachable, or malformed metadata — fall back to deriving
      // the issuer from the transport URL (historical behavior).
      source = "transport";
      issuerUrl = normalizeIssuerUrl(controlPlaneUrl);
      allowedScopes = CP_BOOTSTRAP_SCOPES;
      logger.warn(
        {
          controlPlaneUrl,
          err:
            discoveryErr instanceof Error
              ? discoveryErr.message
              : String(discoveryErr),
        },
        "Federation metadata discovery failed — falling back to CONTROL_PLANE_URL as the issuer"
      );
    }

    if (!issuerUrl) {
      logger.warn(
        { controlPlaneUrl },
        "CONTROL_PLANE_URL is not a valid HTTPS issuer URL — skipping CP trusted-issuer seed"
      );
      return;
    }

    await new TrustedIssuerService().seedBuiltIn([
      {
        issuerUrl,
        displayName: "Synap Control Plane",
        description:
          source === "declared"
            ? "Built-in issuer for the Synap Control Plane (federated sign-in and identity linking). Discovered from /federation/metadata."
            : "Built-in issuer for the Synap Control Plane (federated sign-in and identity linking). Seeded from CONTROL_PLANE_URL.",
        allowedScopes,
      },
    ]);

    logger.info(
      { issuerUrl, source, scopeCount: allowedScopes.length },
      "Seeded Control Plane as built-in trusted issuer"
    );
  } catch (err) {
    logger.warn(
      { err },
      "Failed to seed Control Plane trusted issuer (non-fatal)"
    );
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
  // VAULT_SERVER_KEY is REQUIRED in production: the secret vault (connector
  // tokens, API keys) is non-functional without it, and an EMPTY key makes the
  // pod boot "healthy" with a silently-dead vault — exactly the failure that
  // turned a config gap into a redeem crash-loop. Fail loud at boot instead.
  "VAULT_SERVER_KEY",
];

const REQUIRED_SECRETS_LOCAL_MODE: string[] = [
  "JWT_SECRET",
  "SYNAP_SERVICE_ENCRYPTION_KEY",
  // KRATOS_SECRETS_COOKIE intentionally omitted — Kratos is not used in local mode
  // VAULT_SERVER_KEY intentionally omitted — local dev may run without the vault.
];

const RECOMMENDED_SECRETS: string[] = ["KRATOS_SECRETS_CIPHER"];

/**
 * Validate required secrets — FAIL-FAST, exits the process if any are missing.
 *
 * MUST run BEFORE `serve()` (from the pre-listen config block in index.ts), not
 * inside the post-listen startup hooks: `process.exit(1)` after the health port
 * is already open makes the orchestrator see a healthy-then-crash flap. Exported
 * so index.ts can call it in the same pre-serve fatal-config gate as the other
 * `validateConfig(...)` checks.
 */
export function validateCriticalSecrets(): void {
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
export async function runStartupHooks(): Promise<void> {
  logger.info("🚀 Running startup hooks...");

  // NOTE: required-secret validation now runs PRE-`serve()` in index.ts's config
  // block (a missing secret must fail BEFORE the health port opens, so the
  // orchestrator never sees a healthy-then-crash flap). Do NOT re-add
  // validateCriticalSecrets() here — that would double-run it post-listen.

  ensureChannelGatewayKey();
  await seedDefaultCorsOrigins(); // Ensure synap.dev can reach this pod
  await seedControlPlaneIssuer(); // Deterministically trust the CP for federated sign-in
  // Self-heal existing federated identities: attach the `cp` OIDC credential so
  // "Continue with Synap Cloud" completes silently (no Kratos account-linking).
  // Idempotent + best-effort.
  await backfillFederationOidcCredentials();
  await loadCorsOrigins();
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

  // Seed the `team-member` ROLE profile — load-bearing substrate for the team
  // roster → person bridge (`ensureTeamPersonForMember`), which otherwise
  // silently no-ops when the profile is absent. Idempotent; must run before
  // the team-person-bridge backfill pass below.
  try {
    const result = await ensureTeamMemberRoleProfile();
    logger.info({ ...result }, "team-member role profile seeded on startup");
  } catch (err) {
    logger.warn(
      { err },
      "Failed to seed team-member role profile on startup (non-fatal)"
    );
  }

  // Seed the widget_definitions table from the @synap/capabilities manifest —
  // the SSOT for bento widget kinds the UI reads via trpc.widgetDefinitions.list.
  // Idempotent upsert; was previously carried by the deleted plugins/init.ts.
  try {
    await seedWidgetDefinitions();
    logger.info("Widget definitions seeded on startup");
  } catch (err) {
    logger.warn(
      { err },
      "Failed to seed widget definitions on startup (non-fatal)"
    );
  }

  // Converge every workspace to its canonical template (crm.yaml, content-studio.yaml,
  // …) — additively creates missing profiles / overlay properties / entity links.
  // Must run AFTER ensureSystemProfiles so templates can overlay onto system profiles.
  // Server-side + idempotent: a template change (e.g. a new `partner` profile) lands on
  // EXISTING workspaces on the next boot, with no dependency on any frontend loading.
  try {
    await reconcileWorkspacesToTemplates();
  } catch (err) {
    logger.warn(
      { err },
      "Failed to reconcile workspaces to templates on startup (non-fatal)"
    );
  }

  // Trusted issuers other than the Control Plane are established explicitly
  // through the generic federation bootstrap or by a local Pod owner — a fresh
  // Pod starts with no knowledge of any external issuer. The one exception is
  // the Control Plane itself, seeded above from CONTROL_PLANE_URL when set, so
  // a self-hosted pod deterministically trusts the CP for federated sign-in.

  // LOCAL MODE: ensure the operator user + personal workspace exist in the DB.
  // Must run before verifyPodAdminInvariant so the invariant check sees a user.
  await ensureLocalUser();

  // Pod-admin invariant — non-fatal, surfaces a loud warning if broken so
  // operators see exactly which recovery command to run.
  await verifyPodAdminInvariant();

  // Retrofit person entities + team-member facets for every EXISTING workspace
  // member (the team-person bridge only ran going-forward on membership
  // mutations until now). Idempotent; must run after ensureTeamMemberRoleProfile
  // above and after workspaces/owners exist (local-mode workspace included).
  try {
    await backfillAllWorkspacesTeamPersonBridge();
  } catch (err) {
    logger.warn(
      { err },
      "Failed to backfill team-person bridge on startup (non-fatal)"
    );
  }

  // Seed the synap-core built-in capability (Tier-0 verbs). Idempotent +
  // non-fatal; runs after the pod-owner invariant so an owner exists to attribute
  // the pod-wide skills to (pre-bootstrap pods are skipped and retried next boot).
  await ensureSynapCoreCapability();

  // Seed the AI-teaching-substrate baseline skills (the disk skill packages, as DB
  // rows) — idempotent + drift-healing + non-fatal, same shape as the seeder above.
  try {
    await ensureSystemSkills();
  } catch (err) {
    logger.warn({ err }, "Failed to seed system skills on startup (non-fatal)");
  }

  // Seed the pod-level CAPTURE AGENT — substrate, not surface. Fundamental
  // capture (text/photo → governed structured entity) needs a least-privilege
  // human-owned agent to attribute its writes to. Idempotent + drift-healing +
  // non-fatal; runs after ensureSynapCoreCapability so a pod owner exists to
  // own it (pre-bootstrap pods are skipped and retried next boot).
  try {
    await ensureCaptureAgent();
  } catch (err) {
    logger.warn({ err }, "Failed to seed capture agent on startup (non-fatal)");
  }

  // ONE-STORE BACKFILL (Governance Convergence Plan, Phase B) — seed
  // governance_rules from every existing workspace/agent autoApproveFor JSONB
  // list. Idempotent + standalone (NOT a pg-boss job); must run BEFORE the
  // pod starts serving writes so resolveAgentGovernanceDecision's rung 2.8
  // (which now drives the auto-approve decision instead of the JSONB — see
  // resolve-agent-governance-decision.ts) sees an equivalent rule for every
  // pre-existing override. Non-fatal: logged and skipped on failure, same as
  // every other startup seeder here.
  //
  // TRUE ONE-SHOT: this runs at most ONCE per pod. Past the first successful run
  // it short-circuits on a persisted converged marker and returns
  // `{ skipped: true }` WITHOUT re-reading the legacy JSONB — because diffing
  // that stale JSONB against the LIVE DEFAULT_AUTO_APPROVE floor made every
  // floor TIGHTENING self-undoing at the next boot (see the TRUE ONE-SHOT note
  // in backfill-governance-rules.ts).
  try {
    const { backfillGovernanceRules } = await import("@synap/database");
    const result = await backfillGovernanceRules(db);
    if (result.skipped) {
      logger.debug(
        "governance_rules backfill already converged — legacy autoApproveFor JSONB not re-read"
      );
    } else if (
      result.workspaceRulesInserted > 0 ||
      result.agentRulesInserted > 0 ||
      result.floorCoveredRevoked > 0
    ) {
      logger.info(
        result,
        "Converged governance_rules from autoApproveFor JSONB (diff-only widenings seeded; floor-covered flood revoked)"
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Failed to backfill governance_rules on startup (non-fatal)"
    );
  }

  // Converge every installed capability CONTAINER to its Control-Plane template
  // (the capability-layer counterpart to reconcileWorkspacesToTemplates above) —
  // additively re-projects drifted skills (e.g. a `providerSpec.baseUrlOverride`
  // fix) onto pods that already installed an older version of the template.
  // Must run AFTER ensureSynapCoreCapability so synap-core itself is present to
  // be enumerated (though it self-converges via its own guard either way).
  try {
    const report = await reconcileCapabilitiesToTemplates();
    // Drift the engine deferred to a human (`updatePolicy:"notify"`) surfaces as
    // ONE grouped bell item. Idempotent — no duplicate on an unchanged restart.
    await notifyCapabilityUpdatesAvailable(report);
  } catch (err) {
    logger.warn(
      { err },
      "Failed to reconcile capabilities to templates on startup (non-fatal)"
    );
  }

  // Converge every standalone-installed VIEW / SKILL / AUTOMATION to its source
  // marketplace template (the lighter-config counterpart to the capability +
  // workspace reconciles above). Field-level 3-way merge — never overwrites a
  // user-edited field; a cache miss (private package) is skipped, not an error.
  // Idempotent + non-fatal, same stance as every reconcile here.
  try {
    await reconcileStandaloneConfigsToTemplates();
  } catch (err) {
    logger.warn(
      { err },
      "Failed to reconcile standalone configs to templates on startup (non-fatal)"
    );
  }

  // Light up the rules-ecosystem "WHEN" menu: declare `metadata.emits` for genuine
  // event producers (standing/channel bridges) that carry no explicit declaration
  // yet. Idempotent + non-fatal; MUST run AFTER the capability reconcile above so
  // freshly-installed capabilities and their `produced-->channel` edges exist to be
  // classified. NEVER overwrites an explicit `emits` declaration.
  try {
    const emitsReport = await backfillCapabilityEmits();
    if (emitsReport.litUp.length > 0) {
      logger.info(
        {
          litUp: emitsReport.litUp.map((c) => ({
            name: c.name,
            emits: c.emits,
          })),
        },
        "Declared metadata.emits for standing (bridge) capabilities — honest WHEN menu"
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Failed to backfill capability emits on startup (non-fatal)"
    );
  }

  logger.info("✅ Startup hooks complete");
}
