/**
 * Provision Routes
 *
 * Establishes and manages the Control Plane → Pod connection via HTTP.
 * Used for the Control Plane push flow where CP calls the pod to register itself.
 *
 * Routes:
 *   POST /api/provision/seed-trust            — Bootstrap: CP registers itself as trusted issuer (CP-signed ES256 JWT auth)
 *   POST /api/provision/connect               — CP pushes credentials via signed JWT
 *   POST /api/provision/register-intelligence — IS self-registers its API key via CP-signed JWT
 *   POST /api/provision/reset-intelligence    — Clear stale IS registration (CP-JWT auth)
 *   POST /api/provision/seed-admin            — Atomic admin seeding (Kratos + users + workspace)
 *   POST /api/provision/admin-recovery-link   — Generate Kratos password-recovery link for admin (CP-JWT auth)
 *   GET  /api/provision/status                — Public status check (includes IS credential probe)
 *   POST /api/provision/disconnect            — Remove CP connection (admin only, uses CP JWT)
 *
 * Auth model:
 *   All mutating calls use a short-lived ES256 JWT signed by the Control Plane.
 *   Pods verify via CONTROL_PLANE_URL/.well-known/jwks.json (pinned at install time).
 *   seed-trust uses a "seed-trust"-typed JWT (trust registry empty on first call, so
 *   verification uses the pinned JWKS directly rather than the registry).
 *   No shared secret is required anywhere in the CP→Pod trust chain.
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { createLogger } from "@synap-core/core";
import {
  createAndVerifyHubInboundKey,
  toRegistrationTrace,
  verifyCpJwt,
  verifyCpJwtWithTrust,
} from "@synap/api";
import {
  getDb,
  eq,
  and,
  drizzleSql,
  EventRepository,
  ApiKeyRepository,
  sql,
  seedAdminUser,
  TrustedIssuerService,
} from "@synap/database";
import {
  workspaces,
  intelligenceServices,
  users,
  workspaceMembers,
  apiKeys,
} from "@synap/database/schema";
import { encryptServiceKey, resolveServiceKey } from "@synap/api";
import { getSyncGenerationState } from "@synap/api";

const logger = createLogger({ module: "provision" });
const OPENCLAW_HUB_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

export const provisionRouter = new Hono();

// ─── POST /api/provision/seed-trust ─────────────────────────────────────────
//
// Bootstrap endpoint: the Control Plane introduces itself to the pod as a
// trusted issuer. Called during provisioning and again any time trust needs
// to be re-established (e.g. after pod migration or trust corruption).
//
// Auth: Bearer <CP-signed ES256 JWT>
//   Claims: { type: "seed-trust", aud: <pod PUBLIC_URL>, iss: <CONTROL_PLANE_URL>, jti }
//
// Bootstrap verification — the trusted_issuers registry is empty on first
// call so we CANNOT use verifyCpJwtWithTrust here. Instead we verify the JWT
// directly against CONTROL_PLANE_URL, which is pinned at install time by
// install.sh. This is safe: the CP URL is injected by a trusted channel
// (cloud-init / VPS user-data). No shared secret is required.
//
// Body: { issuerUrl: string }  — the CP's public base URL (e.g. "https://api.synap.live")
//   Must match the CONTROL_PLANE_URL env var — prevents registering a rogue issuer.
//
// On success:
//   1. Inserts/updates trusted_issuers with status="approved", isBuiltIn=true
//   2. Seeds workspace.settings.controlPlane.url so all subsequent provision
//      routes can read cpUrl from the DB instead of an env var.
//
// Idempotent — safe to call multiple times (seedBuiltIn is a no-op if already present).

provisionRouter.post("/seed-trust", async (c) => {
  const cpUrl = process.env.CONTROL_PLANE_URL;
  const podPublicUrl = process.env.PUBLIC_URL;

  if (!cpUrl) {
    logger.error(
      "seed-trust refused: CONTROL_PLANE_URL not configured on this pod"
    );
    return c.json(
      {
        error:
          "CONTROL_PLANE_URL not configured — pod cannot verify CP identity",
      },
      500
    );
  }
  if (!podPublicUrl) {
    logger.error(
      "seed-trust refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json(
      { error: "PUBLIC_URL not configured; seed-trust refused" },
      500
    );
  }

  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Verify against pinned JWKS — bypasses trust registry (which is empty at bootstrap).
  const payload = await verifyCpJwt<{ type: string }>(
    token,
    cpUrl,
    podPublicUrl
  );
  if (!payload || payload.type !== "seed-trust") {
    logger.warn(
      { cpUrl, podPublicUrl },
      "seed-trust rejected: invalid or wrong-type CP JWT"
    );
    return c.json({ error: "Invalid or untrusted seed-trust token" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ issuerUrl: z.string().url() }).safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "issuerUrl is required and must be a valid URL" },
      400
    );
  }
  const { issuerUrl } = parsed.data;

  // Validate issuerUrl matches our pinned CP URL — prevents a valid CP JWT from
  // being used to register a different (attacker-controlled) issuer URL.
  if (issuerUrl !== cpUrl) {
    logger.warn(
      { issuerUrl, cpUrl },
      "seed-trust rejected: issuerUrl does not match CONTROL_PLANE_URL"
    );
    return c.json(
      { error: "issuerUrl must match the configured CONTROL_PLANE_URL" },
      400
    );
  }

  try {
    // 1. Seed the CP into trusted_issuers
    const svc = new TrustedIssuerService();
    await svc.seedBuiltIn([
      {
        issuerUrl,
        displayName: "Synap Cloud",
        description:
          "Synap managed control plane — approved at provisioning time",
        allowedScopes: [
          "setup.agent",
          "provision",
          "tier_update",
          "sync",
          "hub-protocol.read",
          "hub-protocol.write",
        ],
      },
    ]);

    logger.info(
      { issuerUrl, podPublicUrl },
      "Trust established via CP JWT — trusted_issuers seeded"
    );

    // 2. Seed workspace.settings.controlPlane.url so /connect and all other
    //    provision routes can resolve cpUrl from the DB without needing the env var.
    try {
      const db = await getDb();
      const ws = await db.query.workspaces.findFirst();
      if (ws) {
        const existing = (ws.settings as Record<string, unknown>) ?? {};
        const existingCp =
          (existing.controlPlane as Record<string, unknown>) ?? {};
        const merged = {
          ...existing,
          controlPlane: { ...existingCp, url: issuerUrl },
        } as typeof ws.settings;
        await db
          .update(workspaces)
          .set({ settings: merged })
          .where(eq(workspaces.id, ws.id));
      }
    } catch (dbErr) {
      // Non-fatal — /connect will set this properly when called next
      logger.warn(
        { err: dbErr },
        "seed-trust: could not pre-seed workspace.settings.controlPlane.url (non-fatal)"
      );
    }

    return c.json({ success: true, issuerUrl });
  } catch (err) {
    logger.error({ err }, "seed-trust: failed to seed trusted issuer");
    return c.json({ error: "Failed to register trusted issuer" }, 500);
  }
});

// ─── POST /api/provision/connect ────────────────────────────────────────────
//
// Called by the Control Plane (push flow) OR by the CLI after device auth.
// Body: { token: string }
// token is a JWT signed with CP's ES256 private key; pod verifies via JWKS.
// Claims: { type: "provision"|"tier_update", podId, controlPlaneUrl, tier?,
//           intelligenceHubUrl?, intelligenceHubApiKey?,
//           resendApiKey?, resendFromEmail?, appUrl? }
//
// Accepted token types:
//   "provision"    — full provisioning (CP connection + intelligence + tier + email config)
//   "tier_update"  — lightweight tier push only (no intelligence re-registration)
//
// On success, stores data in workspace.settings.controlPlane.
// Returns: { success: true }

provisionRouter.post("/connect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ token: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const { token } = parsed.data;

  // JWT issuer verification uses the Trusted Issuers registry (trusted_issuers
  // table). `verifyCpJwtWithTrust` layers the allowlist check on top of the
  // standard ES256 signature / issuer / expiry / audience / jti verification —
  // only issuers whose `status === "approved"` are accepted.
  //
  // Audience (PUBLIC_URL) is mandatory: a provisioning token minted for another
  // pod must not replay here. If PUBLIC_URL is unset we refuse the request
  // rather than silently skipping the check.
  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "connect refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json(
      { error: "PUBLIC_URL not configured; handshake refused" },
      500
    );
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    controlPlaneUrl: string;
    intelligenceHubUrl?: string;
    tier?: string;
    resendApiKey?: string;
    resendFromEmail?: string;
    appUrl?: string;
    nangoHost?: string;
    nangoRecordsApiKey?: string;
  }>(token, {
    // No pinnedIssuer — trust is gated by trusted_issuers registry (seeded by /seed-trust).
    // The JWT's own `iss` claim is matched against the registry by verifyCpJwtWithTrust.
    audience: podPublicUrl,
  });

  if (!payload) {
    logger.warn("Provision token verification failed");
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }

  const { type, podId, controlPlaneUrl } = payload;

  if (type !== "provision" && type !== "tier_update") {
    return c.json(
      {
        error: `Invalid token type — expected 'provision' or 'tier_update', got '${type}'`,
      },
      400
    );
  }

  if (!podId || !controlPlaneUrl) {
    return c.json({ error: "Provision token missing required claims" }, 400);
  }

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst();
    if (!ws) {
      return c.json({ error: "No workspace found on this pod" }, 404);
    }

    const existing = (ws.settings as Record<string, unknown>) ?? {};
    const existingCp = (existing.controlPlane as Record<string, unknown>) ?? {};

    // Build the updated controlPlane settings block
    const updatedSettings: Record<string, unknown> = { ...existing };

    // Always update the controlPlane block — at minimum update tier
    updatedSettings.controlPlane = {
      ...existingCp,
      url: controlPlaneUrl,
      podId,
      connectedAt: existingCp.connectedAt ?? new Date().toISOString(),
      lastPingAt: null,
      // Tier from CP — stored locally; no CP round-trip needed on tier check
      ...(payload.tier ? { tier: payload.tier } : {}),
      // Email credentials — pod sends invite emails directly via Resend
      ...(payload.resendApiKey ? { resendApiKey: payload.resendApiKey } : {}),
      ...(payload.resendFromEmail
        ? { resendFromEmail: payload.resendFromEmail }
        : {}),
      // App URL for invite deep-links (e.g. https://app.synap.live)
      ...(payload.appUrl ? { appUrl: payload.appUrl } : {}),
      // Authorized IS URL — used by /register-intelligence to validate the registering IS
      ...(payload.intelligenceHubUrl
        ? { authorizedIntelligenceHubUrl: payload.intelligenceHubUrl }
        : {}),
      // Nango connector config — pod uses these to pull sync records directly from Nango
      ...(payload.nangoHost ? { nangoHost: payload.nangoHost } : {}),
      ...(payload.nangoRecordsApiKey
        ? { nangoRecordsApiKey: payload.nangoRecordsApiKey }
        : {}),
    };
    // Intelligence service registration is handled by POST /api/provision/register-intelligence.
    // The IS self-registers its API key directly with the pod after provisioning,
    // so CP never needs to relay IS credentials.

    await db
      .update(workspaces)
      .set({ settings: updatedSettings })
      .where(eq(workspaces.id, ws.id));

    logger.info(
      { podId, controlPlaneUrl },
      "Control Plane connection established"
    );
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to store Control Plane connection");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── POST /api/provision/register-intelligence ───────────────────────────────
//
// Called by the Intelligence Service after it has created its own API key.
// The IS forwards the CP-signed provision JWT (obtained from the CP request body)
// as a Bearer token — this proves CP authorized this IS to register here.
//
// Auth: Bearer <provisionJwt> (ES256 CP JWT, same JWKS chain as /connect)
// Body: { serviceApiKey, serviceUrl, capabilities? }
//
// Security:
//   - JWT must be valid CP-signed ES256 token with type "provision"
//   - payload.intelligenceHubUrl must match body.serviceUrl (prevents rogue IS)
//   - JWT exp = 10 min, standard exp check via verifyCpJwt
//
// Returns: { success: true }

provisionRouter.post("/register-intelligence", async (c) => {
  // Extract Bearer token
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Resolve cpUrl from workspace.settings (set by /seed-trust + /connect)
  let cpUrl: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    cpUrl = cp?.url;
  } catch {
    // fall through to undefined — verifyCpJwtWithTrust reads iss from token, trust registry gates it
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "register-intelligence refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    controlPlaneUrl: string;
    intelligenceHubUrl?: string;
  }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });

  if (!payload) {
    logger.warn({ cpUrl }, "register-intelligence: token verification failed");
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }

  if (payload.type !== "provision") {
    return c.json(
      { error: "Invalid token type for register-intelligence" },
      400
    );
  }

  if (!payload.intelligenceHubUrl) {
    return c.json(
      { error: "Provision token missing intelligenceHubUrl claim" },
      400
    );
  }

  // Parse and validate body
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      serviceApiKey: z.string().min(1),
      serviceUrl: z.string().url(),
      capabilities: z
        .array(z.string())
        .optional()
        .default(["chat", "analysis"]),
    })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { serviceApiKey, serviceUrl, capabilities } = parsed.data;

  // Prevent a rogue IS from registering — URL in body must match JWT claim
  if (payload.intelligenceHubUrl !== serviceUrl) {
    logger.warn(
      { claimed: serviceUrl, authorized: payload.intelligenceHubUrl },
      "register-intelligence: serviceUrl mismatch — rejecting"
    );
    return c.json(
      { error: "serviceUrl does not match authorized intelligenceHubUrl" },
      403
    );
  }

  // Encrypt the key before touching the DB — gives a clear error if the
  // encryption key env var is missing, rather than a generic DB/500 below.
  let encryptedKey: string;
  try {
    encryptedKey = encryptServiceKey(serviceApiKey);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.error({ err }, "register-intelligence: encryption step failed");
    return c.json(
      {
        error: "Pod encryption key not configured",
        detail: msg,
        hint: "Set SYNAP_SERVICE_ENCRYPTION_KEY (or HUB_PROTOCOL_API_KEY as fallback) in the pod environment",
      },
      500
    );
  }

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst();
    if (!ws) {
      return c.json({ error: "No workspace found on this pod" }, 404);
    }

    const SERVICE_ID = "synap-hub";
    await db
      .insert(intelligenceServices)
      .values({
        id: SERVICE_ID,
        serviceId: SERVICE_ID,
        name: "Synap Intelligence Hub",
        description: "Synap-provisioned intelligence service",
        webhookUrl: serviceUrl,
        apiKey: encryptedKey,
        capabilities,
        status: "active",
        enabled: true,
        mcpApproved: true, // Trusted — authorized by CP-signed JWT
      })
      .onConflictDoUpdate({
        // Use the primary key (id) as conflict target — safer than serviceId
        // since both id and serviceId are set to SERVICE_ID, a PK conflict will
        // always match before a serviceId conflict on the same row.
        target: intelligenceServices.id,
        set: {
          webhookUrl: serviceUrl,
          apiKey: encryptedKey,
          capabilities,
          status: "active",
          enabled: true,
          updatedAt: new Date(),
        },
      });

    // Point ALL workspaces on this pod to this IS — resolveIntelligenceService() picks it up.
    // Previously only the first workspace was updated, leaving other workspaces without IS access.
    const allWorkspaces = await db
      .select({ id: workspaces.id, settings: workspaces.settings })
      .from(workspaces);
    for (const wsRow of allWorkspaces) {
      const existingSettings =
        (wsRow.settings as Record<string, unknown>) ?? {};
      await db
        .update(workspaces)
        .set({
          settings: { ...existingSettings, intelligenceServiceId: SERVICE_ID },
        })
        .where(eq(workspaces.id, wsRow.id));
    }

    logger.info(
      { podId: payload.podId, serviceId: SERVICE_ID, serviceUrl },
      "Intelligence service self-registered and activated"
    );

    // Return the pod's Hub Protocol API key so IS can store it in customer_refs.
    // IS uses this key for proactive outbound Hub Protocol calls (event-triggered skills, background tasks).
    let hubProtocolApiKey = process.env.HUB_PROTOCOL_API_KEY ?? "";

    // Auto-generate a Hub Protocol API key if one hasn't been manually configured.
    // This ensures IS always gets a valid key even on fresh pods with no .env setup.
    // Key is rotated on every re-registration (delete + insert).
    if (!hubProtocolApiKey) {
      try {
        const IS_HUB_ID = "intelligence-hub-primary";
        const keyPrefix =
          process.env.NODE_ENV === "production"
            ? "synap_hub_live_"
            : "synap_hub_test_";
        const rawKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;
        const keyHash = await bcrypt.hash(rawKey, 12);

        // Delete any existing IS hub keys before issuing a fresh one.
        await db.delete(apiKeys).where(eq(apiKeys.hubId, IS_HUB_ID));

        await db.insert(apiKeys).values({
          userId: "system",
          keyName: "Intelligence Hub (auto-provisioned)",
          keyPrefix,
          keyHash,
          keyType: "hub_inbound",
          hubId: IS_HUB_ID,
          scope: ["hub-protocol.read", "hub-protocol.write"],
          isActive: true,
        });

        hubProtocolApiKey = rawKey;
        logger.info(
          { podId: payload.podId, keyPrefix },
          "Auto-generated Hub Protocol API key for IS"
        );
      } catch (keyErr) {
        logger.warn(
          { err: keyErr },
          "Failed to auto-generate Hub Protocol API key — IS will lack outbound Hub access"
        );
      }
    }

    return c.json({ success: true, hubProtocolApiKey });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.error({ err }, "Failed to register intelligence service");
    return c.json({ error: "Internal server error", detail: msg }, 500);
  }
});

// ─── POST /api/provision/reset-intelligence ──────────────────────────────────
//
// Clears the IS registration from the pod's database so a fresh set of
// credentials can be registered via /register-intelligence. Use this when
// credentials are stale or corrupted — the pod goes back to `connectionState: partial`
// and the next provision cycle delivers a clean key.
//
// Auth: Bearer <cpJwt> — CP-signed ES256 JWT, MUST be type "provision".
//   Lighter JWT types (e.g. "tier_update") are rejected — they carry no IS authority
//   and must not be able to wipe IS credentials.
//
// Security:
//   - JWT signature verified via JWKS (same as /register-intelligence)
//   - type MUST be "provision" — rejects tier_update and other lightweight token types
//   - payload.podId MUST match the registered controlPlane.podId — prevents JWT replay
//     from a different pod being used to wipe this pod's IS credentials
//
// Returns: { success: true, cleared: boolean }

provisionRouter.post("/reset-intelligence", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Resolve cpUrl and registeredPodId from workspace.settings (set by /seed-trust + /connect)
  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string; podId?: string } | undefined;
    cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "reset-intelligence refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{ type: string; podId: string }>(
    token,
    {
      pinnedIssuer: cpUrl,
      audience: podPublicUrl,
    }
  );
  if (!payload) {
    logger.warn({ cpUrl }, "reset-intelligence: token verification failed");
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }

  // Only "provision" JWTs carry the authority to reset IS credentials.
  // "tier_update" and other lightweight types must not be able to do this.
  if (payload.type !== "provision") {
    logger.warn(
      { type: payload.type },
      "reset-intelligence: rejected — token type must be 'provision'"
    );
    return c.json(
      {
        error:
          "Invalid token type — only 'provision' tokens may reset IS credentials",
      },
      403
    );
  }

  // Require the pod to have been provisioned before we allow a reset.
  // An unprovisioned pod (no registeredPodId) has nothing to reset, and accepting any
  // valid CP JWT here would allow an adversary to pre-occupy a pod's IS slot.
  if (!registeredPodId) {
    return c.json(
      {
        error:
          "Pod is not yet provisioned — cannot reset a registration that does not exist",
      },
      409
    );
  }

  // Verify the JWT was issued for THIS pod — prevents cross-pod JWT replay.
  // A valid provision JWT for Pod A cannot be used to wipe Pod B's IS credentials.
  if (payload.podId !== registeredPodId) {
    logger.warn(
      { jwtPodId: payload.podId, registeredPodId },
      "reset-intelligence: rejected — JWT podId does not match this pod's registered podId"
    );
    return c.json({ error: "Token was not issued for this pod" }, 403);
  }

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst();
    if (!ws) return c.json({ error: "No workspace found" }, 404);

    const SERVICE_ID = "synap-hub";

    // Delete the IS record — pod goes back to connectionState: partial
    const deleted = await db
      .delete(intelligenceServices)
      .where(eq(intelligenceServices.serviceId, SERVICE_ID))
      .returning({ id: intelligenceServices.id });

    // Clear intelligenceServiceId from workspace settings
    const existing = (ws.settings as Record<string, unknown>) ?? {};
    const { intelligenceServiceId: _removed, ...rest } = existing;
    await db
      .update(workspaces)
      .set({ settings: rest })
      .where(eq(workspaces.id, ws.id));

    logger.info(
      { cleared: deleted.length > 0 },
      "Intelligence service registration cleared — ready for fresh re-registration"
    );
    return c.json({ success: true, cleared: deleted.length > 0 });
  } catch (err) {
    logger.error({ err }, "Failed to reset intelligence service");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── POST /api/provision/validate-credentials ────────────────────────────────
//
// Live IS credential probe — calls GET {isUrl}/api/validate with the stored key
// and updates intelligenceServices.status accordingly.
//
// This is the ONLY endpoint that makes an outbound call to the IS for validation.
// /api/provision/status is public and reads the cached DB status instead.
//
// Auth: Bearer <cpJwt>, type MUST be "provision".
// Called by the CP after provisioning to confirm credentials landed correctly.
//
// Security:
//   - type MUST be "provision" (rejects tier_update and other lightweight types)
//   - payload.podId MUST match registered podId — prevents cross-pod JWT replay
//   - pod MUST already be provisioned (registeredPodId must exist) — rejects calls
//     against unprovisioned pods where any valid JWT would otherwise pass
//   - SSRF prevention: the URL probed (svc.webhookUrl) is verified against
//     payload.intelligenceHubUrl from the CP-signed JWT — ensures we only probe
//     the URL the CP explicitly authorized, even if the DB record is tampered
//   - Only HTTP 401 marks credentials as invalid — transient errors (500, 503,
//     network timeout) leave status unchanged to avoid false positives
//
// Returns: { credentialsValid: boolean | null, status: string }

// ============================================================================
// POST /api/provision/seed-admin
// ============================================================================
//
// One-shot admin seeding endpoint — replaces the broken /setup-account webhook
// flow. Called once at pod provisioning (by the Control Plane) to atomically:
//   1. Find-or-create a Kratos identity for the admin email (via admin API).
//   2. Upsert the matching users table row (id = Kratos identity id).
//   3. Ensure a default personal workspace + owner-role membership.
//
// Why this endpoint exists:
//   Kratos only fires `identity.created` webhooks for self-service flows,
//   NOT for admin-API creates. The previous `/setup-account` handler created
//   the identity via the admin API — so the users table stayed empty and the
//   user could log in but was invisible to the admin panel. This endpoint
//   performs Kratos lookup + DB seeding in one pass, no webhook dependency.
//
// Auth: Bearer <cpJwt> — CP-signed ES256 JWT, verified via JWKS + Trusted
//   Issuers registry (same chain as /connect). Claims:
//     { type: "seed-admin", email: string, name?: string, aud: <pod PUBLIC_URL> }
//   Audience MUST equal this pod's PUBLIC_URL (mandatory — prevents replay
//   against another pod). If PUBLIC_URL is unset, the endpoint 500s.
//
// Body: ignored. The authoritative email/name come from the signed JWT.
//
// Idempotent:
//   - If a Kratos identity for the email already exists, it is reused.
//   - If the users row already exists, it is upserted (email/name refreshed).
//   - If the user already has any workspace membership, the first one is
//     returned (no second workspace created).
//   `alreadyExisted` reflects whether the `users` row pre-existed.
//
// Returns: { success: true, userId, workspaceId, alreadyExisted }
provisionRouter.post("/seed-admin", async (c) => {
  // ── Auth: CP-signed JWT, audience-pinned to this pod ──────────────────────
  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "seed-admin refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json(
      { error: "PUBLIC_URL not configured; seed-admin refused" },
      500
    );
  }

  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    email: string;
    name?: string;
    aud: string;
  }>(token, {
    // No pinnedIssuer — trust is gated by trusted_issuers registry (seeded by /seed-trust).
    audience: podPublicUrl,
  });

  if (!payload) {
    logger.warn("seed-admin: token verification failed");
    return c.json({ error: "Invalid or untrusted seed-admin token" }, 401);
  }

  if (payload.type !== "seed-admin") {
    return c.json(
      {
        error: `Invalid token type — expected 'seed-admin', got '${payload.type}'`,
      },
      400
    );
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Invalid or missing email in token claims" }, 400);
  }
  const name = payload.name?.trim() || undefined;

  // ── Resolve Kratos identity (find-or-create via admin API) ────────────────
  //
  // Kept in the handler (not the DB service) so @synap/database stays HTTP-
  // free. A successful lookup short-circuits identity creation for idempotency.
  const kratosAdminUrl =
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434";
  let kratosIdentityId: string | null = null;

  try {
    const listResp = await fetch(
      `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`
    );
    if (listResp.ok) {
      const identities = (await listResp.json()) as Array<{ id: string }>;
      if (Array.isArray(identities) && identities.length > 0) {
        kratosIdentityId = identities[0].id;
      }
    }
  } catch (err) {
    logger.warn(
      { err, email },
      "seed-admin: Kratos identity lookup failed — will attempt create"
    );
  }

  if (!kratosIdentityId) {
    // 32 random bytes → 64-char hex password. The admin never needs this —
    // they go through password recovery to set a real one. It just satisfies
    // Kratos' "password credential required" constraint at identity creation.
    const randomPassword = randomBytes(32).toString("hex");
    try {
      const createResp = await fetch(`${kratosAdminUrl}/admin/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_id: "default",
          traits: { email, ...(name ? { name } : {}) },
          credentials: {
            password: { config: { password: randomPassword } },
          },
          metadata_public: {
            createdVia: "provision-seed",
            setupRequired: false,
            seededAt: new Date().toISOString(),
          },
          verifiable_addresses: [
            {
              value: email,
              verified: true,
              via: "email",
              status: "completed",
            },
          ],
        }),
      });
      if (!createResp.ok) {
        const errBody = await createResp.text().catch(() => "");
        logger.error(
          { status: createResp.status, body: errBody.slice(0, 500), email },
          "seed-admin: failed to create Kratos identity"
        );
        return c.json(
          {
            error: "Failed to create Kratos identity",
            status: createResp.status,
          },
          500
        );
      }
      const newIdentity = (await createResp.json()) as { id: string };
      kratosIdentityId = newIdentity.id;
      logger.info(
        { email, kratosIdentityId },
        "seed-admin: created Kratos identity"
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, email }, "seed-admin: Kratos admin call threw");
      return c.json({ error: "Kratos admin API unreachable", message }, 500);
    }
  }

  if (!kratosIdentityId) {
    return c.json({ error: "Unable to resolve Kratos identity id" }, 500);
  }

  // ── Seed DB (transactional) ──────────────────────────────────────────────
  try {
    const result = await seedAdminUser({
      kratosIdentityId,
      email,
      name,
      emailVerified: true,
    });
    logger.info(
      {
        email,
        userId: result.userId,
        workspaceId: result.workspaceId,
        alreadyExisted: result.alreadyExisted,
      },
      "seed-admin: success"
    );
    return c.json({
      success: true,
      userId: result.userId,
      workspaceId: result.workspaceId,
      alreadyExisted: result.alreadyExisted,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, email }, "seed-admin: DB seed failed");
    return c.json(
      {
        error: "Failed to seed admin user",
        message,
      },
      500
    );
  }
});

// ─── POST /api/provision/admin-recovery-link ────────────────────────────────
//
// Generates a Kratos password-recovery link for the pod's admin account.
// Intended to be called by the CP dashboard when a user needs to set or reset
// their admin password after automated provisioning (seed-admin uses a random
// placeholder password the admin never sees).
//
// Auth: Bearer <CP JWT, type "admin-recovery">
// Claims: { email } — the admin email to generate a recovery link for.
// Returns: { recoveryLink, expiresAt }
provisionRouter.post("/admin-recovery-link", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) return c.json({ error: "PUBLIC_URL not configured" }, 500);

  const payload = await verifyCpJwtWithTrust<{ type: string; email?: string }>(
    token,
    {
      audience: podPublicUrl,
    }
  );
  if (!payload) return c.json({ error: "Invalid or expired token" }, 401);
  if (payload.type !== "admin-recovery") {
    return c.json(
      {
        error: `Invalid token type — expected 'admin-recovery', got '${payload.type}'`,
      },
      403
    );
  }

  const email = payload.email;
  if (!email || typeof email !== "string") {
    return c.json({ error: "Token must include 'email' claim" }, 400);
  }

  const kratosAdminUrl =
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

  // Look up the Kratos identity for this email
  let identityId: string | null = null;
  try {
    const listRes = await fetch(
      `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`
    );
    if (listRes.ok) {
      const identities = (await listRes.json()) as Array<{ id: string }>;
      if (Array.isArray(identities) && identities.length > 0) {
        identityId = identities[0].id;
      }
    }
  } catch (err) {
    logger.error(
      { err, email },
      "admin-recovery-link: Kratos identity lookup failed"
    );
    return c.json({ error: "Failed to contact authentication server" }, 502);
  }

  if (!identityId) {
    return c.json(
      { error: `No Kratos identity found for email: ${email}` },
      404
    );
  }

  // Create a recovery link (valid for 4 hours)
  try {
    const recoveryRes = await fetch(`${kratosAdminUrl}/admin/recovery/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in: "4h", identity_id: identityId }),
    });
    if (!recoveryRes.ok) {
      const body = await recoveryRes.text().catch(() => "");
      logger.error(
        { status: recoveryRes.status, body, email },
        "admin-recovery-link: Kratos recovery link creation failed"
      );
      return c.json(
        { error: `Recovery link generation failed (${recoveryRes.status})` },
        502
      );
    }
    const data = (await recoveryRes.json()) as {
      recovery_link?: string;
      expires_at?: string;
    };
    if (!data.recovery_link) {
      return c.json({ error: "Kratos returned no recovery link" }, 502);
    }
    logger.info(
      { email, identityId },
      "admin-recovery-link: recovery link generated"
    );
    return c.json({
      recoveryLink: data.recovery_link,
      expiresAt: data.expires_at ?? null,
    });
  } catch (err) {
    logger.error({ err, email }, "admin-recovery-link: unexpected error");
    return c.json({ error: "Failed to generate recovery link" }, 500);
  }
});

provisionRouter.post("/validate-credentials", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string; podId?: string } | undefined;
    cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "validate-credentials refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    intelligenceHubUrl?: string;
  }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });
  if (!payload) {
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }
  if (payload.type !== "provision") {
    return c.json(
      {
        error:
          "Invalid token type — only 'provision' tokens may validate credentials",
      },
      403
    );
  }

  // Require the pod to already be provisioned. An unprovisioned pod has no IS to validate,
  // and accepting JWTs without a known podId anchor is weaker than requiring registration first.
  if (!registeredPodId) {
    return c.json(
      {
        error:
          "Pod is not yet provisioned — complete provisioning before validating credentials",
      },
      409
    );
  }
  if (payload.podId !== registeredPodId) {
    logger.warn(
      { jwtPodId: payload.podId, registeredPodId },
      "validate-credentials: rejected — JWT podId does not match this pod's registered podId"
    );
    return c.json({ error: "Token was not issued for this pod" }, 403);
  }

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const intelligenceServiceId = (ws?.settings as Record<string, unknown>)
      ?.intelligenceServiceId as string | undefined;

    if (!intelligenceServiceId) {
      return c.json({ credentialsValid: null, status: "not_registered" });
    }

    const svc = await db.query.intelligenceServices.findFirst({
      where: eq(intelligenceServices.serviceId, intelligenceServiceId),
      columns: { webhookUrl: true, status: true, apiKey: true },
    });

    if (!svc) {
      return c.json({ credentialsValid: null, status: "not_found" });
    }

    if (!svc.apiKey) {
      return c.json({ credentialsValid: null, status: "no_key" });
    }

    // SSRF prevention: the URL we probe must match what the CP authorized in the JWT.
    // This ensures we only call the CP-sanctioned IS endpoint, even if the DB record
    // was somehow modified to point at an internal or attacker-controlled URL.
    if (
      payload.intelligenceHubUrl &&
      svc.webhookUrl !== payload.intelligenceHubUrl
    ) {
      logger.warn(
        { stored: svc.webhookUrl, authorized: payload.intelligenceHubUrl },
        "validate-credentials: stored IS URL does not match JWT-authorized URL — rejecting probe"
      );
      return c.json(
        { error: "Stored IS URL does not match authorized intelligenceHubUrl" },
        403
      );
    }

    // Live probe — decrypt stored key and call IS /api/validate
    // Only HTTP 401 means "key rejected" → credential_error.
    // All other non-2xx (500, 503, network timeout) are transient — don't mark as invalid.
    let credentialsValid: boolean | null = null;
    let newStatus = svc.status;
    let httpStatus: number | null = null;
    try {
      const isKey = resolveServiceKey(svc.apiKey as string);
      const validateRes = await fetch(`${svc.webhookUrl}/api/validate`, {
        headers: { Authorization: `Bearer ${isKey}` },
        signal: AbortSignal.timeout(5000),
      });
      httpStatus = validateRes.status;

      if (validateRes.ok) {
        credentialsValid = true;
        newStatus = "active";
      } else if (validateRes.status === 401) {
        // Definitive rejection — key is not recognized by IS
        credentialsValid = false;
        newStatus = "credential_error";
      } else {
        // IS returned 403, 429, 500, 503, etc. — transient or policy issue, not invalid key
        credentialsValid = null;
        logger.warn(
          { webhookUrl: svc.webhookUrl, httpStatus },
          "IS returned non-401 non-2xx during credential probe — treating as transient, not marking credential_error"
        );
      }

      // Only persist definitive outcomes to DB (true → active, false → credential_error)
      if (credentialsValid !== null) {
        await db
          .update(intelligenceServices)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(intelligenceServices.serviceId, intelligenceServiceId));
      }

      logger.info(
        { credentialsValid, httpStatus, webhookUrl: svc.webhookUrl },
        "IS credential validation complete"
      );
    } catch {
      credentialsValid = null; // network timeout or IS unreachable — not a credential error
      logger.warn(
        { webhookUrl: svc.webhookUrl },
        "IS credential probe timed out or threw — IS may be unreachable (not marking credential_error)"
      );
    }

    return c.json({ credentialsValid, status: newStatus });
  } catch (err) {
    logger.error({ err }, "Credential validation error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── GET /api/provision/status ────────────────────────────────────────────────
//
// Public endpoint — returns current CP connection status + IS registration state.
// Does NOT return any secrets (cpApiKey, IS apiKey).
//
// `credentialsValid` is derived from the cached `intelligenceServices.status` in the
// DB — NOT from a live IS probe. Use POST /api/provision/validate-credentials
// (CP-JWT-gated) to run the live probe and refresh the cached status.
//
// connectionState:
//   "connected"   — CP connection + IS registered + credentials valid
//   "partial"     — CP connection exists but IS missing OR credentials invalid
//   "disconnected"— No CP connection

provisionRouter.get("/status", async (c) => {
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });

    // Optional CP JWT auth: if Authorization header is present, verify it via the
    // trusted_issuers registry. Returns 401 when CP is not yet trusted (seed-trust
    // not called). Public callers without Authorization always get the response.
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const cpUrl = (ws?.settings as Record<string, unknown> | null)
        ?.controlPlane as { url?: string } | undefined;
      const podPublicUrl = process.env.PUBLIC_URL;
      if (podPublicUrl) {
        const payload = await verifyCpJwtWithTrust(token, {
          pinnedIssuer: cpUrl?.url,
          audience: podPublicUrl,
        });
        if (!payload) {
          return c.json(
            { error: "CP not trusted — call /api/provision/seed-trust first" },
            401
          );
        }
      }
    }

    const settings = (ws?.settings as Record<string, unknown>) ?? {};
    const cp = settings.controlPlane as
      | {
          url: string;
          podId: string;
          cpApiKey: string;
          connectedAt: string;
          lastPingAt: string | null;
          authorizedIntelligenceHubUrl?: string;
        }
      | undefined;

    const intelligenceServiceId = settings.intelligenceServiceId as
      | string
      | undefined;
    let intelligenceService: {
      serviceId: string;
      url: string;
      status: string;
    } | null = null;
    // credentialsValid: derived from DB-cached status, NOT a live probe.
    // POST /api/provision/validate-credentials (CP-JWT-gated) updates this.
    let credentialsValid: boolean | null = null;
    const connectionIssues: string[] = [];

    if (intelligenceServiceId) {
      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, intelligenceServiceId),
        columns: {
          serviceId: true,
          webhookUrl: true,
          status: true,
          apiKey: true,
        },
      });
      if (svc) {
        intelligenceService = {
          serviceId: svc.serviceId,
          url: svc.webhookUrl,
          status: svc.status,
        };

        // Use DB-cached status to derive credentialsValid — no live outbound call.
        // "active" = credentials last verified OK (or never checked → assume valid)
        // "credential_error" = live probe previously confirmed stale key
        if (svc.status === "credential_error") {
          credentialsValid = false;
          connectionIssues.push("credentials_invalid");
        } else if (svc.status === "expiring") {
          // Key works but expires within 14 days
          credentialsValid = true;
          connectionIssues.push("key_expiring");
        } else if (svc.status === "active") {
          credentialsValid = true;
        }
        // Other statuses (disabled, etc.) leave credentialsValid = null

        // Check if the stored key can be decrypted — catches missing/changed encryption key
        if (svc.apiKey) {
          try {
            resolveServiceKey(svc.apiKey);
          } catch {
            connectionIssues.push("key_decrypt_failed");
          }
        }
      }
    }

    // Detect "partial" state: CP connected but IS credentials never delivered.
    // This happens when the IS self-registration push failed during provisioning.
    if (cp && !intelligenceService) {
      connectionIssues.push("hub_not_registered");
    }
    if (cp && cp.authorizedIntelligenceHubUrl && !intelligenceService) {
      connectionIssues.push("hub_push_failed");
    }

    const connectionState = !cp
      ? "disconnected"
      : intelligenceService && credentialsValid !== false
        ? "connected"
        : "partial";

    // Resolve the IS URL that the runtime would actually use right now
    let resolvedIsUrl: string | null = null;
    let resolvedIsSource: "database" | "env_fallback" | "none" = "none";
    if (intelligenceService) {
      resolvedIsUrl = intelligenceService.url;
      resolvedIsSource = "database";
    } else {
      const envUrl = process.env.INTELLIGENCE_HUB_URL;
      if (envUrl) {
        resolvedIsUrl = envUrl;
        resolvedIsSource = "env_fallback";
      } else {
        resolvedIsUrl = "http://localhost:3002";
        resolvedIsSource = "env_fallback";
      }
    }

    // Build detailed issue descriptions for each connection issue
    const connectionIssueDetails: Array<{ code: string; hint: string }> = [];
    const issueHints: Record<string, string> = {
      credentials_invalid:
        "API key was rejected by IS. Re-provision to generate a new key.",
      key_decrypt_failed:
        "SYNAP_SERVICE_ENCRYPTION_KEY env var is missing or changed.",
      key_expiring: "API key expires within 14 days. Re-provision to refresh.",
      hub_not_registered:
        "Intelligence Service has not registered with this pod.",
      hub_push_failed: "Credential delivery to pod failed during provisioning.",
    };
    for (const issue of connectionIssues) {
      if (issueHints[issue]) {
        connectionIssueDetails.push({ code: issue, hint: issueHints[issue] });
      }
    }

    return c.json({
      connected: !!cp,
      connectionState,
      connectionIssues,
      connectionIssueDetails:
        connectionIssueDetails.length > 0 ? connectionIssueDetails : undefined,
      // null = IS unreachable (can't check); true/false = probe result
      credentialsValid,
      controlPlane: cp
        ? {
            url: cp.url,
            podId: cp.podId,
            connectedAt: cp.connectedAt,
            lastPingAt: cp.lastPingAt,
            // authorizedHubUrl tells the UI which IS URL is expected to register
            authorizedHubUrl: cp.authorizedIntelligenceHubUrl ?? null,
            // cpApiKey intentionally omitted from status response
          }
        : null,
      intelligenceService: {
        ...intelligenceService,
        resolvedUrl: resolvedIsUrl,
        source: resolvedIsSource,
      },
      // Pod version info — read from env (set by install.sh / synap update)
      podVersion: process.env.BACKEND_VERSION || null,
      // Split-brain status (for frontend banner + CP dashboard)
      ...(await (async () => {
        try {
          const syncState = await getSyncGenerationState();
          return {
            splitBrain: syncState.splitBrainDetected,
            podRole: syncState.role,
          };
        } catch {
          // sync_generation table may not exist yet
          return { splitBrain: false, podRole: "primary" };
        }
      })()),
    });
  } catch (err) {
    logger.error({ err }, "Provision status error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── GET /api/provision/debug ────────────────────────────────────────────────
//
// Operator debug endpoint: returns pod trust state, Kratos health, and token
// configuration without exposing secrets. Requires a valid CP-signed JWT —
// only the Control Plane admin dashboard should call this.

provisionRouter.get("/debug", async (c) => {
  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    return c.json({ error: "PUBLIC_URL not configured" }, 500);
  }

  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  const payload = await verifyCpJwtWithTrust(token, { audience: podPublicUrl });
  if (!payload) {
    return c.json(
      { error: "CP not trusted — call /api/provision/seed-trust first" },
      401
    );
  }

  const kratosAdminUrl =
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

  // Probe Kratos admin health
  let kratosHealthy = false;
  let kratosVersion: string | null = null;
  let kratosError: string | null = null;
  try {
    const healthRes = await fetch(`${kratosAdminUrl}/admin/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthRes.ok) {
      const data = (await healthRes.json()) as { version?: string };
      kratosHealthy = true;
      kratosVersion = data.version ?? null;
    } else {
      kratosError = `HTTP ${healthRes.status}`;
    }
  } catch (err) {
    kratosError = err instanceof Error ? err.message : String(err);
  }

  // Read trusted issuers
  let trustedIssuers: Array<{
    issuerUrl: string;
    status: string;
    isBuiltIn: boolean;
    createdAt: string;
  }> = [];
  let workspaceControlPlane: Record<string, unknown> | null = null;
  try {
    const svc = new TrustedIssuerService();
    const issuers = await svc.list();
    trustedIssuers = issuers.map((i) => ({
      issuerUrl: i.issuerUrl,
      status: i.status,
      isBuiltIn: i.isBuiltIn ?? false,
      createdAt: i.createdAt?.toISOString() ?? "",
    }));

    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as Record<string, unknown> | undefined;
    if (cp) {
      workspaceControlPlane = {
        url: cp.url,
        podId: cp.podId,
        connectedAt: cp.connectedAt,
        lastPingAt: cp.lastPingAt,
      };
    }
  } catch (err) {
    logger.warn({ err }, "debug: could not read trusted issuers or workspace");
  }

  const provToken = process.env.PROVISIONING_TOKEN;

  return c.json({
    pod: {
      publicUrl: podPublicUrl,
      sharedPodMode: process.env.SHARED_POD_MODE === "true",
      kratosAdminUrl,
    },
    trust: {
      cpTrusted: trustedIssuers.some(
        (i) => i.status === "approved" && i.isBuiltIn
      ),
      issuers: trustedIssuers,
      workspaceControlPlane,
    },
    kratos: {
      healthy: kratosHealthy,
      version: kratosVersion,
      error: kratosError,
    },
    provisioningToken: {
      configured: !!provToken,
      // First 8 chars so operator can verify it matches the CP without exposing the full secret
      prefix: provToken ? provToken.slice(0, 8) + "..." : null,
    },
  });
});

// ─── GET /api/provision/diagnose-intelligence ────────────────────────────────
//
// Diagnostic endpoint: resolves the IS URL, probes health/ready, validates auth.
// Public (same auth level as /status) — returns structured diagnostic info.

provisionRouter.get("/diagnose-intelligence", async (c) => {
  const issues: string[] = [];

  // 1. Resolve the IS URL (DB first → env fallback)
  let resolvedUrl: string | null = null;
  let resolvedSource: "database" | "env" | "none" = "none";
  let keyPrefix: string | null = null;

  try {
    const db = await getDb();
    const settings = (
      await db.query.workspaces.findFirst({ columns: { settings: true } })
    )?.settings as Record<string, unknown> | undefined;
    const intelligenceServiceId = settings?.intelligenceServiceId as
      | string
      | undefined;

    if (intelligenceServiceId) {
      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, intelligenceServiceId),
        columns: {
          webhookUrl: true,
          apiKey: true,
          status: true,
          enabled: true,
        },
      });
      if (svc) {
        resolvedUrl = svc.webhookUrl;
        resolvedSource = "database";
        try {
          const decrypted = resolveServiceKey(svc.apiKey);
          keyPrefix = decrypted ? decrypted.slice(0, 12) + "..." : null;
        } catch {
          keyPrefix = null;
          issues.push("key_decrypt_failed");
        }
        if (!svc.enabled) issues.push("service_disabled");
        if (svc.status === "credential_error")
          issues.push("credentials_invalid");
      }
    }

    if (!resolvedUrl) {
      resolvedUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
      resolvedSource = "env";
      if (!process.env.INTELLIGENCE_HUB_URL) {
        issues.push("no_env_url_using_default");
      }
    }
  } catch (err) {
    logger.error({ err }, "diagnose-intelligence: DB resolution failed");
    resolvedUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
    resolvedSource = "env";
    issues.push("db_resolution_error");
  }

  // 2. Health check
  let healthResult: { reachable: boolean; status?: number; body?: unknown } = {
    reachable: false,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(`${resolvedUrl}/health`, {
        signal: controller.signal,
      });
      const body = await resp.json().catch(() => null);
      healthResult = { reachable: true, status: resp.status, body };
      if (!resp.ok) issues.push("health_check_failed");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    healthResult = { reachable: false };
    issues.push("unreachable");
  }

  // 3. Ready check (only if healthy)
  let readyResult: { reachable: boolean; latencyMs?: number } = {
    reachable: false,
  };
  if (healthResult.reachable) {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const resp = await fetch(`${resolvedUrl}/ready`, {
          signal: controller.signal,
        });
        readyResult = { reachable: resp.ok, latencyMs: Date.now() - start };
        if (!resp.ok) issues.push("not_ready");
      } finally {
        clearTimeout(timer);
      }
    } catch {
      readyResult = { reachable: false };
      issues.push("ready_check_failed");
    }
  }

  // 4. Auth validation (only if reachable and we have a key)
  let authResult: { valid: boolean | null; keyPrefix?: string | null } = {
    valid: null,
    keyPrefix,
  };
  if (healthResult.reachable && keyPrefix) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        // Use /health with the API key header as a lightweight auth check
        const resp = await fetch(`${resolvedUrl}/api/validate`, {
          headers: { "X-API-Key": keyPrefix ? "redacted" : "" },
          signal: controller.signal,
        });
        // If the IS has a /api/validate endpoint, use it; otherwise treat 2xx as valid
        authResult = { valid: resp.ok, keyPrefix };
        if (!resp.ok) issues.push("key_rejected");
      } finally {
        clearTimeout(timer);
      }
    } catch {
      authResult = { valid: null, keyPrefix };
    }
  }

  return c.json({
    resolved: { url: resolvedUrl, source: resolvedSource },
    health: healthResult,
    ready: readyResult,
    auth: authResult,
    issues,
  });
});

// ─── GET /api/provision/addon-status ─────────────────────────────────────────
//
// Returns the real-time registration state of an add-on IS from the pod's own
// database. Used by the Control Plane to reconcile its cached provisioning
// status against the pod's source of truth.
//
// ?addon=openclaw → checks whether OpenClaw is registered as an active IS
//
// Auth: Bearer <cpJwt> — type MUST be "addon_status".
//   Same ES256/JWKS chain as all other provision endpoints.
//   The CP calls this during status polling when its DB shows "provisioning".

provisionRouter.get("/addon-status", async (c) => {
  const addon = c.req.query("addon");
  if (!addon)
    return c.json({ error: "addon query parameter is required" }, 400);
  if (addon !== "openclaw")
    return c.json({ error: `Unknown addon: ${addon}` }, 400);

  // Require CP-signed JWT (type "addon_status")
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown>)?.controlPlane as
      | { url?: string; podId?: string }
      | undefined;
    cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "addon-status refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{ type: string; podId: string }>(
    token,
    {
      pinnedIssuer: cpUrl,
      audience: podPublicUrl,
    }
  );
  if (!payload) return c.json({ error: "Invalid or expired token" }, 401);
  if (payload.type !== "addon_status") {
    return c.json(
      { error: "Invalid token type — expected 'addon_status'" },
      400
    );
  }
  if (registeredPodId && payload.podId !== registeredPodId) {
    logger.warn(
      { jwtPodId: payload.podId, registeredPodId },
      "addon-status: podId mismatch — rejecting"
    );
    return c.json({ error: "Token was not issued for this pod" }, 403);
  }

  try {
    const db = await getDb();

    // Check if OpenClaw is registered as an active intelligence service
    // serviceId is "openclaw-{userId-prefix}", so we use a prefix match
    const services = await db.query.intelligenceServices.findMany({
      where: eq(intelligenceServices.status, "active"),
      columns: {
        serviceId: true,
        webhookUrl: true,
        status: true,
        enabled: true,
      },
    });
    const openclawSvc = services.find(
      (s) => s.serviceId.startsWith("openclaw-") && s.enabled
    );

    // Check if the agent user exists (independent of IS registration)
    const agentUser = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        drizzleSql`${users.agentMetadata}->>'agentType' = 'openclaw'`
      ),
      columns: { id: true },
    });

    return c.json({
      addon: "openclaw",
      registered: !!openclawSvc,
      serviceId: openclawSvc?.serviceId ?? null,
      serviceStatus: openclawSvc?.status ?? null,
      agentUserId: agentUser?.id ?? null,
    });
  } catch (err) {
    logger.error({ err }, "addon-status: failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── POST /api/provision/activate-addon ──────────────────────────────────────
//
// Called by the Control Plane to activate an add-on service with proper RBAC.
//
// Auth: Bearer <cpJwt> — ES256 JWT signed by CP, type MUST be "addon_activate".
//       payload.podId MUST match the registered controlPlane.podId.
//
// Body: JWT claims carry { addon, serviceId, workspaceId? }
//
// For addon = "openclaw":
//   1. Find or create a pod-wide OpenClaw agent user
//      (agentMetadata.writesRequireProposal: true — all writes require approval)
//   2. Grant the agent editor membership in the target workspace (idempotent)
//   3. Create a Hub Protocol API key bound to the agent user
//
// Returns: { agentUserId, workspaceId, hubApiKey, keyId, serviceId }
//   hubApiKey is returned ONCE and is never stored in plaintext — the caller
//   (CP job) injects it into the container's environment via SSH.
//
// Security:
//   - JWT signature verified via JWKS (same chain as other provision routes)
//   - type MUST be "addon_activate" (lightweight types cannot create agent users)
//   - payload.podId MUST match registeredPodId — prevents cross-pod replay
//   - Hub API key is bcrypt-hashed before storage; scoped to hub-protocol only

provisionRouter.post("/activate-addon", async (c) => {
  const flowId = randomUUID();
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Resolve cpUrl and registeredPodId from workspace.settings (set by /seed-trust + /connect)
  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown>)?.controlPlane as
      | { url?: string; podId?: string }
      | undefined;
    cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "activate-addon refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    addon: string;
    serviceId: string;
    workspaceId?: string;
  }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });

  if (!payload) {
    logger.warn({ cpUrl }, "activate-addon: token verification failed");
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }

  if (payload.type !== "addon_activate") {
    return c.json(
      { error: "Invalid token type — expected 'addon_activate'" },
      400
    );
  }

  // If the pod has a registered CP podId, verify it matches the JWT.
  // If not registered (self-hosted or pre-CP pods), trust the valid JWT signature.
  if (registeredPodId && payload.podId !== registeredPodId) {
    logger.warn(
      { jwtPodId: payload.podId, registeredPodId },
      "activate-addon: podId mismatch — rejecting"
    );
    return c.json({ error: "Token was not issued for this pod" }, 403);
  }

  if (payload.addon !== "openclaw") {
    return c.json({ error: `Unsupported addon: ${payload.addon}` }, 400);
  }

  try {
    const db = await getDb();

    // Get the pod's workspace (provisioned pods have exactly one primary workspace)
    const ws = await db.query.workspaces.findFirst();
    if (!ws) return c.json({ error: "No workspace found on this pod" }, 404);

    const targetWorkspaceId = payload.workspaceId ?? ws.id;

    // Find the workspace owner — used as agentMetadata.createdByUserId for attribution
    const ownerMember = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, ws.id),
        eq(workspaceMembers.role, "owner")
      ),
      columns: { userId: true },
    });
    const ownerUserId = ownerMember?.userId ?? null;

    // ── 1. Find or create the OpenClaw agent user (pod-wide singleton) ────────
    //
    // One agent user per pod, not per workspace. It's granted access to
    // specific workspaces via workspace_members (step 2).

    const existingAgent = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        drizzleSql`${users.agentMetadata}->>'agentType' = 'openclaw'`
      ),
      columns: { id: true },
    });

    let agentUserId: string;

    if (existingAgent) {
      agentUserId = existingAgent.id;
      logger.info(
        { agentUserId },
        "activate-addon: reusing existing OpenClaw agent user"
      );
    } else {
      agentUserId = randomUUID();
      const shortId = agentUserId.slice(0, 8);
      await db.insert(users).values({
        id: agentUserId,
        email: `agent-openclaw-${shortId}@synap.agent`,
        name: "OpenClaw",
        emailVerified: true,
        userType: "agent",
        kratosIdentityId: null,
        agentMetadata: {
          agentType: "openclaw",
          description:
            "OpenClaw — world-interface AI agent (shell, browser, messaging channels)",
          createdByUserId: ownerUserId ?? agentUserId,
          isPersonalAgent: false,
          writesRequireProposal: true,
          capabilities: ["shell", "browser", "filesystem", "messaging"],
        },
        timezone: "UTC",
        locale: "en",
      });
      logger.info(
        { agentUserId },
        "activate-addon: created OpenClaw agent user"
      );
    }

    // ── 2. Grant workspace membership (idempotent) ────────────────────────────

    const existingMembership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.userId, agentUserId),
        eq(workspaceMembers.workspaceId, targetWorkspaceId)
      ),
      columns: { id: true },
    });

    if (!existingMembership) {
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: targetWorkspaceId,
        userId: agentUserId,
        role: "editor",
        invitedBy: ownerUserId ?? undefined,
      });
      logger.info(
        { agentUserId, targetWorkspaceId },
        "activate-addon: workspace membership granted"
      );
    }

    // ── 3. Create Hub Protocol API key bound to the agent user ────────────────
    //
    // Idempotency: if a key already exists (e.g. Trigger.dev is retrying this
    // job after a later step failed), revoke the old key before creating a new
    // one. The plaintext is returned once only and injected into the container
    // by the CP job via SSH.

    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: agentUserId,
        revokedReason: "Re-provisioning — replaced by new key",
      })
      .where(
        and(
          eq(apiKeys.userId, agentUserId),
          eq(apiKeys.keyType, "hub_inbound"),
          eq(apiKeys.isActive, true)
        )
      );

    const eventRepo = new EventRepository(sql);
    const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
    const registration = await createAndVerifyHubInboundKey(
      apiKeyRepo,
      {
        keyName: "OpenClaw Hub Key",
        hubId: "integration:openclaw",
        scope: OPENCLAW_HUB_SCOPES,
        userId: agentUserId,
        keyType: "hub_inbound",
        description:
          "Hub Protocol auth token for OpenClaw agent — revoked automatically on deprovisioning",
      },
      agentUserId,
      agentUserId
    );
    const registrationTrace = toRegistrationTrace(flowId, registration);
    const { apiKey, plainKey } = registration;
    if (registration.outcome !== "CONNECTED_VERIFIED") {
      logger.error(
        {
          flowId,
          agentUserId,
          addon: payload.addon,
          verificationError: registration.verificationError,
        },
        "activate-addon: key minted but verification failed"
      );
      return c.json(
        {
          error: "Key minted but verification failed",
          code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
          registration: registrationTrace,
        },
        500
      );
    }

    logger.info(
      {
        agentUserId,
        keyId: apiKey.id,
        targetWorkspaceId,
        registration: registrationTrace,
      },
      "activate-addon: Hub API key created"
    );

    return c.json({
      agentUserId,
      workspaceId: targetWorkspaceId,
      hubApiKey: plainKey,
      keyId: apiKey.id,
      serviceId: payload.serviceId,
      registration: registrationTrace,
    });
  } catch (err) {
    logger.error({ err, flowId }, "activate-addon: failed");
    return c.json({ error: "Internal server error", flowId }, 500);
  }
});

// ─── POST /api/provision/deactivate-addon ────────────────────────────────────
//
// Called by the Control Plane when an addon is deprovisioned.
// Removes the agent user's workspace memberships and revokes all active Hub keys
// so the agent can no longer access any workspace even if somehow rekeyed.
//
// Auth: Bearer <cpJwt> — type MUST be "addon_deactivate".
//       payload.podId MUST match registered podId.
//
// This complements Hub API key revocation (done by the CP directly via Hub
// Protocol). Key revocation blocks access immediately; this endpoint removes
// the identity relationship from the pod's DB for clean long-term hygiene.

provisionRouter.post("/deactivate-addon", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown>)?.controlPlane as
      | { url?: string; podId?: string }
      | undefined;
    cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "deactivate-addon refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    addon: string;
    agentUserId?: string;
  }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });

  if (!payload) {
    return c.json({ error: "Invalid or expired provision token" }, 401);
  }
  if (payload.type !== "addon_deactivate") {
    return c.json(
      { error: "Invalid token type — expected 'addon_deactivate'" },
      400
    );
  }
  if (!registeredPodId || payload.podId !== registeredPodId) {
    return c.json({ error: "Token was not issued for this pod" }, 403);
  }
  if (payload.addon !== "openclaw") {
    return c.json({ error: `Unsupported addon: ${payload.addon}` }, 400);
  }

  try {
    const db = await getDb();

    // Locate the OpenClaw agent — prefer agentUserId from JWT claim, fall back to lookup
    let agentUserId = payload.agentUserId;
    if (!agentUserId) {
      const agent = await db.query.users.findFirst({
        where: and(
          eq(users.userType, "agent"),
          drizzleSql`${users.agentMetadata}->>'agentType' = 'openclaw'`
        ),
        columns: { id: true },
      });
      agentUserId = agent?.id;
    }

    if (!agentUserId) {
      return c.json({ success: true, cleaned: false });
    }

    // Remove all workspace memberships — agent retains no access after this
    const deleted = await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, agentUserId))
      .returning({ id: workspaceMembers.id });

    // Belt-and-suspenders: revoke any remaining active Hub keys in DB
    // (CP already called revokeHubApiKeyOnPod via Hub Protocol before this)
    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: agentUserId,
        revokedReason: "Addon deprovisioned",
      })
      .where(and(eq(apiKeys.userId, agentUserId), eq(apiKeys.isActive, true)));

    logger.info(
      { agentUserId, membershipsRemoved: deleted.length },
      "deactivate-addon: OpenClaw agent memberships removed"
    );

    return c.json({
      success: true,
      cleaned: true,
      agentUserId,
      membershipsRemoved: deleted.length,
    });
  } catch (err) {
    logger.error({ err }, "deactivate-addon: failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── POST /api/provision/disconnect ──────────────────────────────────────────
//
// Removes the Control Plane connection.
// Auth: same JWT mechanism (type: "deprovision") OR an admin can call this
// directly from the CLI (which writes to DB directly, bypassing this endpoint).

provisionRouter.post("/disconnect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ token: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const { token } = parsed.data;

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "disconnect refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  let cpUrl: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    cpUrl = cp?.url;
  } catch {
    /* fall through */
  }

  const payload = await verifyCpJwtWithTrust<{ type?: string }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Only "provision" JWTs carry the authority to remove the CP connection.
  // "tier_update" JWTs are distributed more broadly and must not be able to disconnect.
  if (payload.type !== "provision") {
    return c.json(
      {
        error:
          "Invalid token type — only 'provision' tokens may disconnect the pod",
      },
      403
    );
  }

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst();
    if (!ws) {
      return c.json({ error: "No workspace found" }, 404);
    }

    const settings = (ws.settings as Record<string, unknown>) ?? {};
    const { controlPlane: _removed, ...rest } = settings;
    await db
      .update(workspaces)
      .set({ settings: rest })
      .where(eq(workspaces.id, ws.id));

    logger.info("Control Plane connection removed");
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to remove Control Plane connection");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── POST /api/provision/trigger-update ──────────────────────────────────────
//
// Pod update trigger. CP calls this with a signed JWT containing the target
// version. The backend spawns a detached `updater` container (docker:cli)
// that pulls images, runs migrations, restarts services, and calls back
// to the CP with the result. The updater survives the backend restart.
//
// Auth: CP-signed ES256 JWT (verified via JWKS).
// Replay protection: nonce in JWT, rejected if already seen.
// Rate limiting: rejects if an update is already in progress.
//
// Returns immediately: { accepted: true } — update runs asynchronously.

// Nonce cache for replay protection (10 min TTL, matching JWT expiry)
const seenNonces = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}, 60_000);

// In-memory update lock
let updateInProgress = false;

provisionRouter.post("/trigger-update", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  let cpUrl: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    cpUrl = cp?.url;
  } catch {
    /* fall through */
  }

  if (!cpUrl) {
    return c.json(
      { error: "No Control Plane connection — run /seed-trust first" },
      403
    );
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "trigger-update refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    targetVersion?: string;
    updateId?: string;
    podId?: string;
    nonce?: string;
    callbackUrl?: string;
    callbackJwt?: string;
  }>(token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });
  if (!payload || payload.type !== "provision") {
    return c.json({ error: "Invalid or expired JWT" }, 401);
  }

  const targetVersion = payload.targetVersion;
  if (!targetVersion) {
    return c.json({ error: "targetVersion is required in JWT claims" }, 400);
  }

  // Replay protection: reject seen nonces
  if (payload.nonce) {
    if (seenNonces.has(payload.nonce)) {
      return c.json(
        { error: "Duplicate nonce — update already triggered" },
        409
      );
    }
    seenNonces.set(payload.nonce, Date.now());
  }

  // Rate limiting: reject if update already running
  if (updateInProgress) {
    return c.json({ error: "Update already in progress" }, 409);
  }

  logger.info(
    { targetVersion, updateId: payload.updateId, nonce: payload.nonce },
    "Received update trigger from CP"
  );

  // Sanitize version tag (defense in depth — JWT is trusted, but shell injection is bad)
  const sanitizedVersion = targetVersion.replace(/[^a-zA-Z0-9._-]/g, "");

  // Spawn detached updater container via Docker socket.
  // The updater runs update-pod.sh which: pulls, migrates, restarts, health-checks,
  // and calls back to CP with the result. It survives the backend container restart.
  const { exec } = await import("child_process");

  const callbackUrl = payload.callbackUrl || "";
  const callbackJwt = payload.callbackJwt || "";
  const updateId = payload.updateId || "";

  // Use docker compose with the updater profile to spawn a detached one-shot container
  const cmd = [
    "docker compose",
    "-f /opt/synap/deploy/docker-compose.yml",
    "--profile updater",
    "run -d --rm updater",
    sanitizedVersion,
    updateId,
    `"${callbackUrl}"`,
    `"${callbackJwt}"`,
  ].join(" ");

  updateInProgress = true;
  exec(cmd, { timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) {
      logger.error(
        { err: err.message, stderr },
        "Failed to spawn updater container"
      );
      updateInProgress = false;
    } else {
      logger.info({ stdout: stdout.trim() }, "Updater container spawned");
      // Release the lock after 15 min max (safety net if callback never fires)
      setTimeout(
        () => {
          updateInProgress = false;
        },
        15 * 60 * 1000
      );
    }
  });

  return c.json({ accepted: true, targetVersion, updateId });
});
