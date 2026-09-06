/**
 * Provision Routes
 *
 * Operational Pod provisioning routes.
 *
 * Federation identity, membership, and issuer-link flows live under
 * `/api/federation`. Legacy identity routes remain as explicit 410 responses
 * only, so an older client cannot silently re-enable the retired architecture.
 *
 * Routes:
 *   POST /api/provision/register-intelligence — Intelligence service registration
 *   POST /api/provision/reset-intelligence    — Clear stale intelligence registration
 *   GET  /api/provision/status                — Public status check (includes IS credential probe)
 *   POST /api/provision/disconnect            — Remove a provisioning connection
 *
 * Retired compatibility endpoints:
 *   /connect          → no generic replacement (optional operations are local)
 *   /authorize-issuer → /api/federation/identity-links
 *   /seed-trust      → /api/federation/identity-links
 *   /seed-admin      → Pod-local setup, then /api/federation/access-grants
 *   /activate-member → /api/federation/access-grants
 */

import { Hono, type Context } from "hono";
import { probeIntelligenceService } from "./provision-intelligence-probe.js";
import { z } from "zod";
import { randomUUID, randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { createLogger } from "@synap-core/core";
import {
  createAndVerifyHubInboundKey,
  encryptServiceKey,
  getSyncGenerationState,
  resolveServiceKey,
  toRegistrationTrace,
  verifyTrustedIssuerJwt,
} from "@synap/api";
import {
  getDb,
  eq,
  and,
  EventRepository,
  ApiKeyRepository,
  sql,
  TrustedIssuerService,
} from "@synap/database";
import {
  workspaces,
  intelligenceServices,
  users,
  workspaceMembers,
  apiKeys,
} from "@synap/database/schema";

const logger = createLogger({ module: "provision" });
const OPENCLAW_HUB_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/**
 * Reports whether the pod's SMTP courier is wired to a real relay.
 *
 * Reads `SMTP_CONNECTION_URI` (mirrored from .env into the backend container
 * by docker-compose so we can self-introspect — Kratos itself reads
 * COURIER_SMTP_CONNECTION_URI directly, which is the same value).
 *
 * The localhost:1025 default is a catch-all that swallows mail without
 * delivering it. Users hit this when CP didn't pass --smtp-uri at provision
 * time, which makes password reset and Kratos recovery emails silently fail.
 */
function courierStatus(): {
  status: "configured" | "catchall" | "unknown";
  host: string | null;
  // Only populated when status==="configured". Helps users sanity-check that
  // they actually configured the relay they think they did (e.g. resend.com).
  scheme: string | null;
} {
  const uri = process.env.SMTP_CONNECTION_URI;
  if (!uri) {
    return { status: "unknown", host: null, scheme: null };
  }
  let host: string | null = null;
  let scheme: string | null = null;
  try {
    const u = new URL(uri);
    host = u.hostname || null;
    scheme = u.protocol.replace(/:$/, "") || null;
  } catch {
    // malformed URI — treat as unknown rather than catchall, since we can't
    // tell what the operator intended.
    return { status: "unknown", host: null, scheme: null };
  }
  const isCatchAll =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  return {
    status: isCatchAll ? "catchall" : "configured",
    host,
    scheme,
  };
}

export const provisionRouter = new Hono();

function retiredProvisioningEndpoint(c: Context, successor?: string) {
  c.header("Deprecation", "true");
  if (successor) {
    c.header("Link", `<${successor}>; rel=\"successor-version\"`);
  }
  return c.json(
    {
      error: successor
        ? "This legacy provisioning endpoint has been retired."
        : "This Control-Plane-specific provisioning endpoint has been retired.",
      ...(successor ? { successor } : {}),
    },
    410
  );
}

// ─── Retired: POST /api/provision/authorize-issuer ─────────────────────────

provisionRouter.post("/authorize-issuer", (c) =>
  retiredProvisioningEndpoint(c, "/api/federation/identity-links")
);

// ─── Retired: POST /api/provision/seed-trust ────────────────────────────────

provisionRouter.post("/seed-trust", (c) =>
  retiredProvisioningEndpoint(c, "/api/federation/identity-links")
);

// ─── Retired: POST /api/provision/connect ────────────────────────────────────
//
// A Pod must not persist a provider's Pod ID, URL, user identity, or trust
// relationship as a prerequisite for user access. Initial ownership is the
// generic, owner-authorized `/api/federation/bootstrap` flow; later user access
// uses the generic trusted-issuer federation endpoints. Optional operational
// integrations are configured independently of authentication and membership.

provisionRouter.post("/connect", (c) => retiredProvisioningEndpoint(c));

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
//   - JWT exp = 10 min, standard expiry verification via the trusted issuer
//     verifier
//
// Returns: { success: true }

provisionRouter.post("/register-intelligence", async (c) => {
  // Extract Bearer token
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);

  // Resolve the legacy issuer binding from workspace settings when it exists.
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
    // Fall through to undefined: the trusted issuer registry still gates `iss`.
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "register-intelligence refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyTrustedIssuerJwt<{
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
    // Round-trip validation: ensure the key can be decrypted before committing.
    // Catches format regressions at provision time instead of at first user message.
    if (resolveServiceKey(encryptedKey) !== serviceApiKey) {
      throw new Error(
        "Encryption round-trip mismatch — key cannot be recovered"
      );
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.error({ err }, "register-intelligence: encryption step failed");
    return c.json(
      {
        error: "Pod encryption key not configured or encryption failed",
        detail: msg,
        hint: "Set SYNAP_SERVICE_ENCRYPTION_KEY in the pod environment (openssl rand -hex 32)",
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

    // Mint a FRESH pod-read key for THIS IS and return it so the IS stores it in
    // its directory (customer_refs.hubProtocolApiKey). That stored copy is the
    // single source of truth the IS presents on every callback — there is NO env
    // var: a registry-minted random key is correct precisely because the IS keeps
    // what we return here. (The pod keeps only the bcrypt hash, to validate.)
    let hubProtocolApiKey = "";

    try {
      // Key the row PER-IS by serviceId (not a global "intelligence-hub-primary"),
      // so connecting a SECOND intelligence service never clobbers this one's key.
      // Each IS in the directory owns its own is_internal pod-read key.
      const isHubId = SERVICE_ID;
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";

      hubProtocolApiKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;
      const keyHash = await bcrypt.hash(hubProtocolApiKey, 12);

      // Replace only THIS IS's prior key (scoped per-IS — never cross-IS).
      await db.delete(apiKeys).where(eq(apiKeys.hubId, isHubId));

      await db.insert(apiKeys).values({
        userId: "system",
        keyName: `Intelligence Hub IS Key (${SERVICE_ID})`,
        keyPrefix,
        keyHash,
        // TRUSTED Intelligence-Service pod-read key. keyType "is_internal" is the
        // ONLY value that activates the X-Delegated-Operator-Id auth gate in
        // hub-protocol-rest.ts, so the IS orchestrator can read the pod on behalf
        // of the operator whose turn it is processing (operator-floor delegation).
        // This is the SINGLE provisioning point for is_internal — gated above by a
        // CP-signed ES256 JWT (type="provision", JWKS-verified, audience-pinned,
        // serviceUrl matched to the JWT claim). No public mint path can set it.
        keyType: "is_internal",
        hubId: isHubId,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        isActive: true,
      });

      logger.info(
        { podId: payload.podId, serviceId: SERVICE_ID, keyPrefix },
        "Minted per-IS pod-read key (is_internal) for IS directory"
      );
    } catch (keyErr) {
      logger.warn(
        { err: keyErr },
        "Failed to mint IS pod-read key — IS will lack outbound Hub access"
      );
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

  // Resolve the legacy issuer binding from workspace settings when it exists.
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

  const payload = await verifyTrustedIssuerJwt<{ type: string; podId: string }>(
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

// ─── Retired: POST /api/provision/seed-admin ────────────────────────────────
//
// Initial ownership must be created through Pod-local setup. Once a Pod has an
// approved issuer and a local scope, issuer-driven membership uses access-grants.

provisionRouter.post("/seed-admin", (c) =>
  retiredProvisioningEndpoint(c, "/api/federation/access-grants")
);

// ─── Retired: POST /api/provision/activate-member ───────────────────────────

provisionRouter.post("/activate-member", (c) =>
  retiredProvisioningEndpoint(c, "/api/federation/access-grants")
);

// ─── Retired: POST /api/provision/admin-recovery-link ───────────────────────
//
// Password recovery is a direct user-authentication flow, not an issuer action.

provisionRouter.post("/admin-recovery-link", (c) =>
  retiredProvisioningEndpoint(c, "/self-service/recovery/browser")
);

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

  const payload = await verifyTrustedIssuerJwt<{
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

    // Optional trusted-issuer auth. Public callers without Authorization always
    // get the response; an untrusted issuer receives 401.
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const cpUrl = (ws?.settings as Record<string, unknown> | null)
        ?.controlPlane as { url?: string } | undefined;
      const podPublicUrl = process.env.PUBLIC_URL;
      if (podPublicUrl) {
        const payload = await verifyTrustedIssuerJwt(token, {
          pinnedIssuer: cpUrl?.url,
          audience: podPublicUrl,
        });
        if (!payload) {
          return c.json({ error: "Issuer is not approved for this Pod" }, 401);
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
      string | undefined;
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

    // LIVE reachability of the URL the runtime would actually use. Every field
    // above this line is a cached DB row; this one asks the service. Both are
    // reported, because they answer different questions and a pod can be
    // unregistered-but-serving (env fallback) or registered-but-down.
    const serviceProbe = await probeIntelligenceService(resolvedIsUrl);

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
      // null when unprovisioned — same contract as controlPlane above. Spreading
      // a null here would emit `{}`, which reads as "provisioned, status unknown"
      // to every consumer that truth-tests the object.
      intelligenceService: intelligenceService
        ? {
            ...intelligenceService,
            resolvedUrl: resolvedIsUrl,
            source: resolvedIsSource,
          }
        : null,
      // LIVE probe of the resolved IS URL — the ONE fact here that is measured
      // rather than remembered. `reachable: true` alongside
      // `intelligenceService: null` is a real and common state: the pod is
      // serving AI through the env fallback while the CP registration row is
      // absent or stale. Consumers must treat this as evidence of REACHABILITY
      // only — it does not assert that credentials are valid.
      serviceProbe: {
        ...serviceProbe,
        url: resolvedIsUrl,
        source: resolvedIsSource,
      },
      // Pod version info — read from env (set by install.sh / synap update)
      podVersion: process.env.BACKEND_VERSION || null,
      // Courier (SMTP) status — drives the "no recovery email arriving" warning
      // on the dashboard. We don't actually send mail from the backend; Kratos
      // does. We only mirror SMTP_CONNECTION_URI here so the backend can report
      // whether the courier is wired to a real relay or the localhost catch-all.
      // - status="configured" → real SMTP host, mail should deliver
      // - status="catchall"   → smtp://localhost:1025 default, mail goes nowhere
      // - status="unknown"    → env var missing (older pod, env wasn't mirrored
      //                          to the backend container — pod may still send
      //                          mail correctly via Kratos, just can't self-report)
      courier: courierStatus(),
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
// configuration without exposing secrets. Requires a valid approved-issuer
// JWT, so only a Pod operator's trusted control surface can call this.

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
  const payload = await verifyTrustedIssuerJwt(token, {
    audience: podPublicUrl,
  });
  if (!payload) {
    return c.json({ error: "Issuer is not approved for this Pod" }, 401);
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
      string | undefined;

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
  // Same probe `/status` uses — one implementation, so the two endpoints can
  // never disagree about whether the service answered. `noCache` because a
  // diagnostic must reflect NOW, not a memo from five seconds ago.
  const probe = await probeIntelligenceService(resolvedUrl, {
    timeoutMs: 5_000,
    noCache: true,
  });
  const healthResult = {
    reachable: probe.reachable,
    status: probe.httpStatus,
    latencyMs: probe.latencyMs,
  };
  if (!probe.reachable) {
    issues.push(probe.error === "timeout" ? "health_timeout" : "unreachable");
  }

  // Readiness — distinct from health: the process answers, but is it serving?
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

  // Credential validity is NOT probed here, and must not be guessed.
  //
  // What stood here sent the LITERAL STRING "redacted" as the API key to
  // `/api/validate` and reported `valid: resp.ok`. It could never validate
  // anything: a real key was never sent, so a rejection proved nothing and an
  // acceptance would have proved less. It reported `key_rejected` on a healthy
  // pod with correct credentials.
  //
  // The live credential check already exists as its own door —
  // POST /api/provision/validate-credentials — which holds the decrypted key
  // and refreshes the cached `intelligenceServices.status`. `null` here means
  // "not checked on this path", which is the truth.
  const authResult: { valid: boolean | null; keyPrefix?: string | null } = {
    valid: null,
    keyPrefix,
  };

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
      { url?: string; podId?: string } | undefined;
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

  const payload = await verifyTrustedIssuerJwt<{ type: string; podId: string }>(
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

    // Agent user for the workspace owner (creator × type). CP addon path is
    // owner-attributed; multi-human surface keys use provisionSurfaceAgentKey.
    const ownerMember = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.role, "owner"),
      columns: { userId: true },
    });
    const agentUser = ownerMember?.userId
      ? await db.query.users.findFirst({
          where: and(
            eq(users.userType, "agent"),
            eq(users.agentType, "openclaw"),
            eq(users.createdByUserId, ownerMember.userId)
          ),
          columns: { id: true },
        })
      : await db.query.users.findFirst({
          // Fail-safe when no owner row: still prefer agentType column over
          // metadata-only; do not invent a cross-creator match.
          where: and(
            eq(users.userType, "agent"),
            eq(users.agentType, "openclaw")
          ),
          columns: { id: true },
          // TODO(multi-human): require owner/creator once CP status carries it
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
//   1. Find or create OpenClaw agent user for the workspace owner
//      (creator × type; agentMetadata.writesRequireProposal: true)
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

  // Resolve the legacy issuer binding from workspace settings when it exists.
  let cpUrl: string | undefined;
  let registeredPodId: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown>)?.controlPlane as
      { url?: string; podId?: string } | undefined;
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

  const payload = await verifyTrustedIssuerJwt<{
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

    // ── 1. Find or create OpenClaw agent for workspace owner (creator × type) ─
    //
    // CP addon path attributes the agent to the workspace owner. Without an
    // owner we cannot enforce (creator, agentType) — fail closed rather than
    // minting a creator-less singleton that collides under migration 0228.
    if (!ownerUserId) {
      logger.error(
        { flowId, targetWorkspaceId },
        "activate-addon: no workspace owner — cannot attribute OpenClaw agent"
      );
      return c.json(
        {
          error:
            "No workspace owner to attribute the OpenClaw agent to (createdByUserId required)",
          code: "NO_HUMAN_OWNER",
        },
        409
      );
    }

    const existingAgent = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        eq(users.agentType, "openclaw"),
        eq(users.createdByUserId, ownerUserId)
      ),
      columns: { id: true },
    });

    let agentUserId: string;

    if (existingAgent) {
      agentUserId = existingAgent.id;
      logger.info(
        { agentUserId, createdByUserId: ownerUserId },
        "activate-addon: reusing existing OpenClaw agent user for creator×type"
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
        // Dual-write identity columns (migration 0038 / 0228) — not metadata-only
        agentType: "openclaw",
        isPersonalAgent: false,
        createdByUserId: ownerUserId,
        agentMetadata: {
          agentType: "openclaw",
          description:
            "OpenClaw — world-interface AI agent (shell, browser, messaging channels)",
          createdByUserId: ownerUserId,
          isPersonalAgent: false,
          writesRequireProposal: true,
          capabilities: ["shell", "browser", "filesystem", "messaging"],
        },
        timezone: "UTC",
        locale: "en",
      });
      logger.info(
        { agentUserId, createdByUserId: ownerUserId },
        "activate-addon: created OpenClaw agent user for creator×type"
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
      { url?: string; podId?: string } | undefined;
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

  const payload = await verifyTrustedIssuerJwt<{
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

    // Locate the OpenClaw agent — prefer agentUserId from JWT claim; fall back
    // to creator×type for the workspace owner (same attribution as activate).
    let agentUserId = payload.agentUserId;
    if (!agentUserId) {
      const ownerMember = await db.query.workspaceMembers.findFirst({
        where: eq(workspaceMembers.role, "owner"),
        columns: { userId: true },
      });
      if (ownerMember?.userId) {
        const agent = await db.query.users.findFirst({
          where: and(
            eq(users.userType, "agent"),
            eq(users.agentType, "openclaw"),
            eq(users.createdByUserId, ownerMember.userId)
          ),
          columns: { id: true },
        });
        agentUserId = agent?.id;
      }
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

  const payload = await verifyTrustedIssuerJwt<{ type?: string }>(token, {
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
      { error: "No approved provisioning issuer is connected to this Pod" },
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

  const payload = await verifyTrustedIssuerJwt<{
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
  const { execFile } = await import("child_process");

  const callbackUrl = payload.callbackUrl || "";
  const callbackJwt = payload.callbackJwt || "";
  const updateId = payload.updateId || "";

  // install.sh places docker-compose.yml directly at $INSTALL_DIR (e.g. /opt/synap/docker-compose.yml)
  // without a deploy/ subdir. Use the systemd WorkingDirectory (/opt/synap) as the implicit dir.
  // Pass each value as a discrete argv element (no shell) so callbackUrl/callbackJwt/updateId
  // can never break out via `$(...)`, backticks, or quotes.
  const args = [
    "compose",
    "-f",
    "/opt/synap/docker-compose.yml",
    "--profile",
    "updater",
    "run",
    "-d",
    "--rm",
    "updater",
    sanitizedVersion,
    updateId,
    callbackUrl,
    callbackJwt,
  ];

  updateInProgress = true;
  execFile("docker", args, { timeout: 30_000 }, (err, stdout, stderr) => {
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
