/**
 * Hub Protocol REST — CP-MCP consent-code redeem endpoint.
 *
 * The server-to-server half of the CP-MCP pod-accept gate
 * (MCP-OAUTH-AND-CONNECT-PLAN §2-3). The control plane (CP) holds a pod master
 * key and, after the user authorized it at pod-admin `/connect`, redeems the
 * one-time consent code minted there. The pod mints the `claude-web` agent key
 * AT REDEEM (never at Allow) so no plaintext key ever travels through a
 * browser-facing channel.
 *
 * Auth = BOTH credentials:
 *   1. a valid pod key Bearer (the CP master key) — enforced by the hub-protocol
 *      auth middleware (this route is intentionally NOT in skipAuthPaths).
 *   2. the one-time consent `code` in the body — single-use, short-TTL, verified
 *      here against a stored sha256 hash.
 *
 * Mounted at POST /mcp/redeem (→ /api/hub/mcp/redeem).
 */

import { createHash } from "crypto";

import { db, mcpConnectCodes, and, eq, isNull, gt } from "@synap/database";
import { isValidScope, type ApiKeyScope } from "@synap/database/schema";

import { provisionSurfaceAgentKey } from "../../../services/agent-identity-service.js";
import { verifyTrustedIssuerJwt } from "../../../utils/jwks-client.js";
import { logger, type HubHono } from "./_shared.js";

/**
 * Functional default scope set for a claude-web MCP agent key — the same
 * capability surface as `INTEGRATION_HUB_SCOPES.custom`. An MCP agent drives the
 * pod's `/mcp` endpoint, which dispatches through the hub, so it needs both the
 * `mcp.*` scopes AND their `hub-protocol.*` peers to function end-to-end.
 */
const MCP_CONNECT_DEFAULT_SCOPES: readonly ApiKeyScope[] = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
];

/**
 * Map incoming CP-grammar scopes (`mcp:read` / `mcp:write`, colon-separated) to
 * valid pod `api_keys` scopes (`mcp.read` / `mcp.write`, dot-separated), and
 * ensure the hub-protocol peer of each mcp scope is present so the minted key can
 * actually drive the pod's `/mcp` endpoint (MCP tool dispatch gates on the
 * matching `hub-protocol.*` scope). Unknown/invalid scopes are dropped; an empty
 * result falls back to the functional default set.
 *
 * Exported for unit testing (scope-grammar mapping is part of the CP↔pod contract).
 */
export function mapCpScopesToPodScopes(
  raw: readonly string[] | null | undefined
): ApiKeyScope[] {
  if (!raw || raw.length === 0) return [...MCP_CONNECT_DEFAULT_SCOPES];

  const mapped = new Set<ApiKeyScope>();
  for (const s of raw) {
    // CP grammar separates with ':' (mcp:read); pod grammar uses '.' (mcp.read).
    const normalized = s.replace(/:/g, ".").trim();
    if (isValidScope(normalized)) mapped.add(normalized);
  }

  // An MCP grant needs the matching hub-protocol scope to function (tool dispatch
  // rides the hub). Read implies hub-protocol.read; write implies both.
  if (mapped.has("mcp.read")) mapped.add("hub-protocol.read");
  if (mapped.has("mcp.write")) {
    mapped.add("hub-protocol.write");
    mapped.add("hub-protocol.read");
  }

  if (mapped.size === 0) return [...MCP_CONNECT_DEFAULT_SCOPES];
  return Array.from(mapped);
}

export function registerMcpRedeemRoutes(app: HubHono): void {
  app.post("/mcp/redeem", async (c) => {
    // ── Auth: a CP TRUSTED-ISSUER assertion (NOT a hub API key) ──────────────
    // This route is in `skipAuthPaths`, so the key-format middleware does NOT
    // run. CP authenticates with a short-lived JWT it signs (`signCpJwt`), which
    // the pod verifies against its `trusted_issuers` registry — the SAME trust
    // primitive `/auth/exchange` uses. (The CP-held pod credential is a random
    // bootstrap secret, not a `synap_*` key, so a key Bearer could never work.)
    // The one-time `code` below is the SECOND required credential.
    const authToken = c.req
      .header("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1];
    const audience = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    if (!audience) {
      logger.error(
        "mcp/redeem: PUBLIC_URL not configured — cannot verify CP assertion"
      );
      return c.json({ error: "Pod misconfigured (PUBLIC_URL)" }, 500);
    }
    if (!authToken) {
      return c.json(
        { error: "unauthorized", reason: "missing_assertion" },
        401
      );
    }
    const cpClaims = await verifyTrustedIssuerJwt<{ mcp_redeem?: unknown }>(
      authToken,
      { audience }
    );
    if (!cpClaims) {
      logger.warn(
        "mcp/redeem: CP assertion failed trusted-issuer verification"
      );
      return c.json(
        { error: "unauthorized", reason: "invalid_assertion" },
        401
      );
    }
    // Defense in depth: the assertion must have been minted FOR redeem, so a CP
    // JWT signed for another purpose can't be replayed here.
    if (cpClaims.mcp_redeem !== true) {
      logger.warn("mcp/redeem: CP assertion not scoped to mcp_redeem");
      return c.json({ error: "unauthorized", reason: "wrong_purpose" }, 401);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const instanceId =
      typeof body.instanceId === "string" && body.instanceId.trim()
        ? body.instanceId.trim()
        : undefined;
    if (!code) {
      return c.json({ error: "code is required" }, 400);
    }

    const codeHash = createHash("sha256").update(code).digest("hex");

    // Atomically CLAIM the code: mark it consumed only if it is currently
    // unconsumed AND unexpired. Doing the check-and-consume in ONE
    // `UPDATE … RETURNING` closes the double-redeem race — two concurrent
    // redeems cannot both win the row. Claim-before-mint (rather than
    // mint-then-consume) is the security-correct order for single-use: a failed
    // mint burns the code (the user just re-runs the connect flow), but two
    // valid keys can never be minted from one code.
    const now = new Date();
    const [row] = await db
      .update(mcpConnectCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(mcpConnectCodes.codeHash, codeHash),
          isNull(mcpConnectCodes.consumedAt),
          gt(mcpConnectCodes.expiresAt, now)
        )
      )
      .returning({
        podUserId: mcpConnectCodes.podUserId,
        scopes: mcpConnectCodes.scopes,
        agentType: mcpConnectCodes.agentType,
      });

    if (!row) {
      // Missing / expired / already-consumed all collapse to one generic 400 —
      // never leak whether a given code EXISTS on this pod.
      logger.warn(
        { codeHashPrefix: codeHash.slice(0, 12) },
        "mcp/redeem: invalid, expired, or already-redeemed code"
      );
      return c.json(
        { error: "Invalid, expired, or already-redeemed code" },
        400
      );
    }

    const scopes = mapCpScopesToPodScopes(row.scopes);

    try {
      // Mint the claude-web agent key NOW via the ONE door. The agent USER is a
      // pod-wide singleton per agentType (dedup lives inside), but each human
      // gets a DISTINCT KEY: own linkedUserId (this human) + own instanceId.
      // NOT idempotent — every redeem is a fresh consent and mints a fresh key.
      const provisioned = await provisionSurfaceAgentKey({
        agentType: row.agentType, // "claude-web"
        createdByUserId: row.podUserId,
        linkedUserId: row.podUserId, // the key acts for THIS human
        instanceId,
        scopes,
        ensureRegistryRow: true,
        agentLabel: "Claude (Web)",
        keyName: "Claude Web Hub Key",
        keyDescription:
          "Hub Protocol auth token for claude-web MCP agent — created via CP-MCP pod-accept",
        agentDescription: "Claude (claude.ai web) — external MCP agent",
        logger,
      });

      // Defensive: we never pass `idempotent`, so provisionSurfaceAgentKey always
      // revokes+mints and returns a fresh registration. If it ever short-circuits
      // to `alreadyValid` (no fresh plaintext), we CANNOT recover a usable key —
      // fail loudly rather than return a broken contract.
      if (provisioned.alreadyValid) {
        logger.error(
          { agentUserId: provisioned.agentUserId, agentType: row.agentType },
          "mcp/redeem: unexpected alreadyValid — no fresh key to return"
        );
        return c.json(
          {
            error: "Key provisioning returned no fresh key",
            code: "REDEEM_NO_FRESH_KEY",
          },
          500
        );
      }

      const { registration, plainKey, keyId, agentUserId } = provisioned;
      if (registration.outcome !== "CONNECTED_VERIFIED") {
        logger.error(
          {
            agentUserId,
            agentType: row.agentType,
            verificationError: registration.verificationError,
          },
          "mcp/redeem: key minted but verification failed"
        );
        return c.json(
          {
            error: "Key minted but verification failed",
            code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
          },
          500
        );
      }

      logger.info(
        {
          agentUserId,
          keyId,
          podUserId: row.podUserId,
          agentType: row.agentType,
        },
        "mcp/redeem: claude-web agent key minted"
      );

      // ── CONTRACT (Wave B consumes this exact shape) ──────────────────────────
      return c.json({
        apiKey: plainKey, // plaintext — returned ONCE, never retrievable
        keyId,
        podUserId: row.podUserId,
        scopes,
        agentUserId,
      });
    } catch (err) {
      logger.error(
        { err, podUserId: row.podUserId },
        "mcp/redeem: mint failed"
      );
      return c.json({ error: "Internal server error" }, 500);
    }
  });
}
