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
 *   GET  /api/provision/status                — Liveness for anyone; details for the CP or a pod admin
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
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcrypt";
import { createLogger } from "@synap-core/core";
import { getSession } from "@synap/auth";
import {
  attachFullAccessGrant,
  encryptServiceKey,
  describeServingIntelligence,
  envIntelligenceEndpoint,
  getSyncGenerationState,
  podAudience,
  resolveServiceKey,
  verifyTrustedIssuerJwt,
} from "@synap/api";
import { getDb, eq, drizzleSql, TrustedIssuerService } from "@synap/database";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  workspaces,
  intelligenceServices,
  apiKeys,
} from "@synap/database/schema";

import { courierStatus } from "../courier-status.js";
import { buildPodUpdatesStatus, readLastUpdate } from "../pod-updates/index.js";
import { readPodUpdateSettingsRaw } from "./pod-updates-deps.js";
import { findAccountByIdentity, isPodAdmin } from "./account-recovery-deps.js";

/** The id (and serviceId) of the CP-provisioned intelligence service row. */
const SYNAP_HUB_SERVICE_ID = "synap-hub";

const logger = createLogger({ module: "provision" });

export const provisionRouter = new Hono();

function retiredProvisioningEndpoint(c: Context, successor?: string) {
  c.header("Deprecation", "true");
  if (successor) {
    c.header("Link", `<${successor}>; rel="successor-version"`);
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

  const podPublicUrl = podAudience();
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
    // Bound to the row it is written to: the fixed SYNAP_HUB_SERVICE_ID below.
    encryptedKey = encryptServiceKey(serviceApiKey, {
      column: "intelligence_services.api_key",
      rowId: SYNAP_HUB_SERVICE_ID,
    });
    // Round-trip validation: ensure the key can be decrypted before committing.
    // Catches format regressions at provision time instead of at first user message.
    if (
      resolveServiceKey(encryptedKey, {
        column: "intelligence_services.api_key",
        rowId: SYNAP_HUB_SERVICE_ID,
      }) !== serviceApiKey
    ) {
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

    const SERVICE_ID = SYNAP_HUB_SERVICE_ID;
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
      // Revoke through the one door first (drops the verification cache),
      // then remove the replaced rows.
      await revokeApiKeys(db, {
        where: eq(apiKeys.hubId, isHubId),
        reason: "Replaced by a re-provisioned IS key",
      });
      await db.delete(apiKeys).where(eq(apiKeys.hubId, isHubId));

      const [isKey] = await db
        .insert(apiKeys)
        .values({
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
        })
        .returning({ id: apiKeys.id });
      // The IS's own service key: full reach, explicit (deny by default).
      await attachFullAccessGrant({
        apiKeyId: isKey.id,
        principalUserId: "system",
        onBehalfOf: "system",
        expiresAt: null,
        createdBy: "system",
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

  const podPublicUrl = podAudience();
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

  const podPublicUrl = podAudience();
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
      columns: { id: true, webhookUrl: true, status: true, apiKey: true },
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
      const isKey = resolveServiceKey(svc.apiKey as string, {
        column: "intelligence_services.api_key",
        rowId: svc.id,
      });
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
// Anyone gets the LIVENESS answer: connection state, issue codes, whether the
// IS credential is valid and the IS row's status — `restricted: true`, no
// identifier, no URL, no live probe (an anonymous caller cannot make the pod
// call out). The DETAILS (the pod's CP id, the IS URLs and the live probe,
// version, update history, courier host, split-brain) go to its approved
// Control Plane (a CP-signed JWT through the one trusted-issuer door, type
// `pod-status`, or `provision` from older CP callers) or a pod admin's
// session. A Bearer token that fails verification is a 401, as before.
// Never returns a secret (cpApiKey, IS apiKey) to anyone.
//
// `credentialsValid` is derived from the cached `intelligenceServices.status` in the
// DB — NOT from a live IS probe. Use POST /api/provision/validate-credentials
// (CP-JWT-gated) to run the live probe and refresh the cached status.
//
// connectionState:
//   "connected"   — CP connection + IS registered + credentials valid
//   "partial"     — CP connection exists but IS missing OR credentials invalid
//   "disconnected"— No CP connection

/**
 * Who reads the status: "details" for the pod's approved Control Plane (a
 * CP-signed JWT, verified and consumed by the one trusted-issuer door) or a
 * pod admin's session; "public" for anyone else; "denied" when a Bearer token
 * was presented and refused. A session that is not a pod admin's is public.
 */
async function statusReader(
  c: Context,
  cpUrl: string | undefined
): Promise<"details" | "public" | "denied"> {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const audience = podAudience();
    if (!audience) return "denied";
    const payload = await verifyTrustedIssuerJwt(authHeader.slice(7), {
      pinnedIssuer: cpUrl,
      audience,
      expectedType: ["pod-status", "provision"],
    });
    return payload ? "details" : "denied";
  }
  if (!c.req.header("cookie") && !c.req.header("x-session-token")) {
    return "public";
  }
  try {
    const session = await getSession(c.req.raw.headers);
    const identityId = session?.identity?.id as string | undefined;
    if (!identityId) return "public";
    const account = await findAccountByIdentity(identityId);
    return account && (await isPodAdmin(account.userId)) ? "details" : "public";
  } catch (err) {
    // A failed session read is not an admin; the caller still gets liveness.
    logger.warn({ err }, "provision status: session read failed");
    return "public";
  }
}

provisionRouter.get("/status", async (c) => {
  try {
    const db = await getDb();
    // The CP connection is POD-level state that lives in the settings of the
    // workspace it was written to — NOT of "whichever workspace comes first".
    // `findFirst()` with no filter read an arbitrary space, so a pod whose
    // first space carried no `controlPlane` reported `connected:false` /
    // "disconnected" while the CP link was fine.
    const ws =
      (await db.query.workspaces.findFirst({
        columns: { settings: true },
        where: drizzleSql`${workspaces.settings}->'controlPlane' IS NOT NULL`,
      })) ??
      (await db.query.workspaces.findFirst({ columns: { settings: true } }));

    const reader = await statusReader(
      c,
      (
        (ws?.settings as Record<string, unknown> | null)?.controlPlane as
          { url?: string } | undefined
      )?.url
    );
    if (reader === "denied") {
      return c.json({ error: "Issuer is not approved for this Pod" }, 401);
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

    // The service that ACTUALLY serves — through the resolver routing itself
    // uses (capability → workspace → user → pod default → env), never a
    // `workspaces.findFirst().settings.intelligenceServiceId` read, which named
    // whichever space came first. Optional `?workspaceId=` lenses it to one
    // space; without it this is the pod-level answer (the pod default).
    const wsParam = c.req.query("workspaceId");
    if (
      wsParam !== undefined &&
      !z.string().uuid().safeParse(wsParam).success
    ) {
      return c.json({ error: "workspaceId must be a UUID" }, 400);
    }
    const serving = await describeServingIntelligence({
      workspaceId: wsParam,
    });
    const svc = serving.service;

    // `intelligenceService` stays the REGISTERED-row record (consumers read
    // `.status` to decide `active`); an env-served pod keeps it null and is
    // named by `serviceProbe.source: "env_fallback"` below.
    let intelligenceService: {
      serviceId: string;
      url: string;
      status: string;
    } | null = null;
    // credentialsValid: derived from DB-cached status, NOT a live probe.
    // POST /api/provision/validate-credentials (CP-JWT-gated) updates this.
    let credentialsValid: boolean | null = null;
    const connectionIssues: string[] = [];

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
          resolveServiceKey(svc.apiKey, {
            column: "intelligence_services.api_key",
            rowId: svc.id,
          });
        } catch {
          connectionIssues.push("key_decrypt_failed");
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

    if (reader === "public") {
      return c.json({
        restricted: true,
        connected: !!cp,
        connectionState,
        connectionIssues,
        connectionIssueDetails:
          connectionIssueDetails.length > 0
            ? connectionIssueDetails
            : undefined,
        credentialsValid,
        intelligenceService: intelligenceService
          ? { status: intelligenceService.status }
          : null,
      });
    }

    // The URL the runtime actually uses — the resolver's own answer.
    const resolvedIsUrl: string = serving.url;
    const resolvedIsSource: "database" | "env_fallback" =
      serving.source === "registered" ? "database" : "env_fallback";

    // LIVE reachability of the URL the runtime would actually use. Every field
    // above this line is a cached DB row; this one asks the service. Both are
    // reported, because they answer different questions and a pod can be
    // unregistered-but-serving (env fallback) or registered-but-down.
    const serviceProbe = await probeIntelligenceService(resolvedIsUrl);

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
      // Auto-update setting (U3) + the engine's last outcome (U4). The CP's
      // health poll reads this to decide whether to push a release and to
      // email the owner when an update rolled back. Metadata only — no path,
      // no secret; each half reports its own failed read instead of a default.
      updates: await buildPodUpdatesStatus({
        readSettingsRaw: readPodUpdateSettingsRaw,
        readLastUpdate: () => readLastUpdate(),
      }),
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
  const podPublicUrl = podAudience();
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
      // A fingerprint (`sha256:` + 8 hex), never characters of the token: an
      // operator compares it with the CP's, nothing of the secret leaves.
      fingerprint: provToken ? keyFingerprintOf(provToken) : null,
    },
  });
});

/**
 * `sha256:` + the first 8 hex of the key's SHA-256 — enough for an operator to
 * tell two keys apart, nothing of the key itself. `/diagnose-intelligence` is
 * unauthenticated and used to return the first 12 characters of the decrypted
 * IS key.
 */
export function keyFingerprintOf(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

// ─── GET /api/provision/diagnose-intelligence ────────────────────────────────
//
// Diagnostic endpoint: resolves the IS URL, probes health/ready, validates auth.
// Public (same auth level as /status) — returns structured diagnostic info.

provisionRouter.get("/diagnose-intelligence", async (c) => {
  const issues: string[] = [];

  // 1. Resolve the service that ACTUALLY serves — through the resolver routing
  //    itself uses (capability → workspace → user → pod default → env). This
  //    used to read `workspaces.findFirst().settings.intelligenceServiceId`,
  //    i.e. whichever space came first, so it could diagnose a service nobody
  //    routes to. `?workspaceId=` lenses it to one space (that space's pinned
  //    service, else the pod default).
  const wsParam = c.req.query("workspaceId");
  if (wsParam !== undefined && !z.string().uuid().safeParse(wsParam).success) {
    return c.json({ error: "workspaceId must be a UUID" }, 400);
  }

  let resolvedUrl: string | null = null;
  let resolvedSource: "database" | "env" | "none" = "none";
  let resolvedVia: string | null = null;
  // A fingerprint, never characters of the key: this route is public.
  let keyFingerprint: string | null = null;

  try {
    const serving = await describeServingIntelligence({
      workspaceId: wsParam,
    });
    resolvedUrl = serving.url;
    resolvedVia = serving.via;
    const svc = serving.service;
    if (svc) {
      resolvedSource = "database";
      try {
        const decrypted = resolveServiceKey(svc.apiKey, {
          column: "intelligence_services.api_key",
          rowId: svc.id,
        });
        keyFingerprint = decrypted ? keyFingerprintOf(decrypted) : null;
      } catch {
        keyFingerprint = null;
        issues.push("key_decrypt_failed");
      }
      if (!svc.enabled) issues.push("service_disabled");
      if (svc.status === "credential_error") issues.push("credentials_invalid");
    } else {
      resolvedSource = "env";
      if (!process.env.INTELLIGENCE_HUB_URL) {
        issues.push("no_env_url_using_default");
      }
    }
  } catch (err) {
    logger.error({ err }, "diagnose-intelligence: resolution failed");
    resolvedUrl = envIntelligenceEndpoint();
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
  const authResult: {
    valid: boolean | null;
    keyFingerprint: string | null;
  } = {
    valid: null,
    keyFingerprint,
  };

  return c.json({
    resolved: { url: resolvedUrl, source: resolvedSource, via: resolvedVia },
    health: healthResult,
    ready: readyResult,
    auth: authResult,
    issues,
  });
});

// ─── Retired: the OpenClaw add-on endpoints ──────────────────────────────────
//
// GET addon-status, POST activate-addon and POST deactivate-addon served one
// add-on, OpenClaw, which Synap no longer bundles (2026-10-14: any agent connects
// through its own key). An older Control Plane may still call them: it gets an
// explicit 410, never a guess.

provisionRouter.get("/addon-status", (c) => retiredProvisioningEndpoint(c));
provisionRouter.post("/activate-addon", (c) => retiredProvisioningEndpoint(c));
provisionRouter.post("/deactivate-addon", (c) =>
  retiredProvisioningEndpoint(c)
);

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

  const podPublicUrl = podAudience();
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
