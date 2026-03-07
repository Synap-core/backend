/**
 * Provision Routes
 *
 * Establishes and manages the Control Plane → Pod connection via HTTP.
 * Used for the Control Plane push flow where CP calls the pod to register itself.
 *
 * Routes:
 *   POST /api/provision/connect               — CP pushes credentials via signed JWT
 *   POST /api/provision/register-intelligence — IS self-registers its API key via CP-signed JWT
 *   GET  /api/provision/status                — Public status check
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
import { encryptServiceKey } from "@synap/api";

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

// ─── GET /api/provision/status ────────────────────────────────────────────────
//
// Public endpoint — returns current CP connection status.
// Does NOT return the cpApiKey (sensitive).

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
      }
    }

    return c.json({
      connected: !!cp,
      controlPlane: cp
        ? {
            url: cp.url,
            podId: cp.podId,
            connectedAt: cp.connectedAt,
            lastPingAt: cp.lastPingAt,
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
