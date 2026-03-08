/**
 * Provision Routes
 *
 * Establishes and manages the Control Plane → Pod connection via HTTP.
 * Used for the Control Plane push flow where CP calls the pod to register itself.
 *
 * Routes:
 *   POST /api/provision/connect               — CP pushes credentials via signed JWT
 *   POST /api/provision/register-intelligence — IS self-registers its API key via CP-signed JWT
 *   POST /api/provision/reset-intelligence    — Clear stale IS registration (CP-JWT auth)
 *   GET  /api/provision/status                — Public status check (includes IS credential probe)
 *   POST /api/provision/disconnect            — Remove CP connection (admin only, uses CP JWT)
 *
 * Auth model:
 *   All mutating calls use a short-lived ES256 JWT signed by the Control Plane.
 *   Pods verify via /.well-known/jwks.json — no shared secret required.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger, config } from "@synap-core/core";
import { verifyCpJwt } from "@synap/api";
import { getDb, eq } from "@synap/database";
import { workspaces, intelligenceServices } from "@synap/database/schema";
import { encryptServiceKey, resolveServiceKey } from "@synap/api";

const logger = createLogger({ module: "provision" });

export const provisionRouter = new Hono();

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

  // Verify the JWT via CP JWKS (ES256). cpUrl may be baked into the JWT as
  // controlPlaneUrl, but for the first-ever provision the pod uses the env var.
  const cpUrl =
    config.server.controlPlaneUrl ??
    (() => {
      // Try to decode without verifying to extract controlPlaneUrl for JWKS fetch.
      // This is safe — we verify the full signature right after.
      try {
        const decoded = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString("utf-8")
        ) as { controlPlaneUrl?: string };
        return decoded.controlPlaneUrl;
      } catch {
        return undefined;
      }
    })();

  const payload = await verifyCpJwt<{
    type: string;
    podId: string;
    controlPlaneUrl: string;
    intelligenceHubUrl?: string;
    tier?: string;
    resendApiKey?: string;
    resendFromEmail?: string;
    appUrl?: string;
  }>(token, cpUrl);

  if (!payload) {
    logger.warn({ cpUrl }, "Provision token verification failed");
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

  // Resolve cpUrl from workspace settings (set by /connect) or env
  let cpUrl: string | undefined = config.server.controlPlaneUrl;
  if (!cpUrl) {
    try {
      const db = await getDb();
      const ws = await db.query.workspaces.findFirst({
        columns: { settings: true },
      });
      const cp = (ws?.settings as Record<string, unknown> | null)
        ?.controlPlane as { url?: string } | undefined;
      cpUrl = cp?.url;
    } catch {
      // fall through to undefined — verifyCpJwt will attempt JWKS from token claim
    }
  }

  const payload = await verifyCpJwt<{
    type: string;
    podId: string;
    controlPlaneUrl: string;
    intelligenceHubUrl?: string;
  }>(token, cpUrl);

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
        apiKey: encryptServiceKey(serviceApiKey),
        capabilities,
        status: "active",
        enabled: true,
        mcpApproved: true, // Trusted — authorized by CP-signed JWT
      })
      .onConflictDoUpdate({
        target: intelligenceServices.serviceId,
        set: {
          webhookUrl: serviceUrl,
          apiKey: encryptServiceKey(serviceApiKey),
          capabilities,
          status: "active",
          enabled: true,
          updatedAt: new Date(),
        },
      });

    // Point workspace to this IS — resolveIntelligenceService() picks it up
    const existing = (ws.settings as Record<string, unknown>) ?? {};
    await db
      .update(workspaces)
      .set({ settings: { ...existing, intelligenceServiceId: SERVICE_ID } })
      .where(eq(workspaces.id, ws.id));

    logger.info(
      { podId: payload.podId, serviceId: SERVICE_ID, serviceUrl },
      "Intelligence service self-registered and activated"
    );
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to register intelligence service");
    return c.json({ error: "Internal server error" }, 500);
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

  // Resolve cpUrl from workspace settings or env
  let cpUrl: string | undefined = config.server.controlPlaneUrl;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string; podId?: string } | undefined;
    if (!cpUrl) cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const payload = await verifyCpJwt<{ type: string; podId: string }>(
    token,
    cpUrl
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

  // Verify the JWT was issued for THIS pod — prevents cross-pod JWT replay.
  // A valid provision JWT for Pod A cannot be used to wipe Pod B's IS credentials.
  if (registeredPodId && payload.podId !== registeredPodId) {
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
// Called by the CP status endpoint when it wants an accurate credential picture.
//
// Returns: { credentialsValid: boolean | null, status: string }

provisionRouter.post("/validate-credentials", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  let cpUrl: string | undefined = config.server.controlPlaneUrl;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string; podId?: string } | undefined;
    if (!cpUrl) cpUrl = cp?.url;
    registeredPodId = cp?.podId;
  } catch {
    /* fall through */
  }

  const payload = await verifyCpJwt<{ type: string; podId: string }>(
    token,
    cpUrl
  );
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
  if (registeredPodId && payload.podId !== registeredPodId) {
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

    // Live probe — decrypt stored key and call IS /api/validate
    let credentialsValid: boolean | null = null;
    let newStatus = svc.status;
    try {
      const isKey = resolveServiceKey(svc.apiKey as string);
      const validateRes = await fetch(`${svc.webhookUrl}/api/validate`, {
        headers: { Authorization: `Bearer ${isKey}` },
        signal: AbortSignal.timeout(5000),
      });
      credentialsValid = validateRes.ok;
      newStatus = credentialsValid ? "active" : "credential_error";

      // Persist result to DB so /status can use it without making outbound calls
      await db
        .update(intelligenceServices)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(intelligenceServices.serviceId, intelligenceServiceId));

      logger.info(
        { credentialsValid, webhookUrl: svc.webhookUrl },
        "IS credential validation complete"
      );
    } catch {
      credentialsValid = null; // IS unreachable — can't determine validity
      logger.warn(
        { webhookUrl: svc.webhookUrl },
        "IS credential probe timed out — IS may be unreachable"
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
        columns: { serviceId: true, webhookUrl: true, status: true },
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
        } else if (svc.status === "active") {
          credentialsValid = true;
        }
        // Other statuses (disabled, etc.) leave credentialsValid = null
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

    return c.json({
      connected: !!cp,
      connectionState,
      connectionIssues,
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
      intelligenceService,
    });
  } catch (err) {
    logger.error({ err }, "Provision status error");
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

  const cpUrl = config.server.controlPlaneUrl;
  const payload = await verifyCpJwt<{ type?: string }>(token, cpUrl);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
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
