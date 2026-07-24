/**
 * Hub Protocol REST — CP-MCP consent-code redeem + revoke endpoints.
 *
 * The server-to-server half of the CP-MCP pod-accept gate
 * (MCP-OAUTH-AND-CONNECT-PLAN §2-3). The control plane (CP) holds a pod master
 * key and, after the user authorized it at pod-admin `/connect`, redeems the
 * one-time consent code minted there. The pod mints the `claude-web` agent key
 * AT REDEEM (never at Allow) so no plaintext key ever travels through a
 * browser-facing channel. On disconnect the CP calls the sibling /mcp/revoke
 * endpoint to kill that same key server-to-server.
 *
 * Auth for BOTH routes = a CP TRUSTED-ISSUER assertion (verifyCpAssertion
 * below), NOT a hub API key: the CP-held pod credential (`intelligenceApiKey`)
 * is a random bootstrap secret, not a `synap_*` key, so it could never pass the
 * key-format middleware. Both routes are listed in `skipAuthPaths`
 * (hub-protocol-rest.ts) so that middleware doesn't run, and each verifies its
 * OWN purpose claim (`mcp_redeem` / `mcp_revoke`) so a redeem assertion can't
 * be replayed as a revoke and vice-versa.
 *
 * redeem additionally requires the one-time consent `code` in the body —
 * single-use, short-TTL, verified against a stored sha256 hash.
 *
 * Mounted at POST /mcp/redeem and POST /mcp/revoke (→ /api/hub/mcp/*).
 */

import { createHash } from "crypto";

import {
  db,
  mcpConnectCodes,
  and,
  eq,
  isNull,
  gt,
  users,
  ApiKeyRepository,
  EventRepository,
  sql,
} from "@synap/database";
import {
  apiKeys,
  isValidScope,
  type ApiKeyScope,
} from "@synap/database/schema";

import { provisionSurfaceAgentKey } from "../../../services/agent-identity-service.js";
import { verifyTrustedIssuerJwt } from "../../../utils/jwks-client.js";
import { logger, type HubHono } from "./_shared.js";

/**
 * Minimal shape both routes' `c` argument needs from the Hono context — kept
 * loose (rather than importing Hono's `Context<...>` generic) so this helper
 * is trivially reusable across both route handlers below.
 */
interface CpAssertionContext {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status: number) => Response;
}

/**
 * Verify a CP trusted-issuer assertion carrying the given purpose claim
 * (`mcp_redeem` or `mcp_revoke`). Returns the 401/500 `Response` to return
 * immediately on failure, or `null` when the assertion is valid — the SAME
 * auth block both /mcp/redeem and /mcp/revoke share, factored out so the two
 * routes can't drift.
 */
async function verifyCpAssertion(
  c: CpAssertionContext,
  purposeClaim: "mcp_redeem" | "mcp_revoke"
): Promise<Response | null> {
  const authToken = c.req
    .header("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1];
  const audience = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!audience) {
    logger.error(
      `mcp/${purposeClaim}: PUBLIC_URL not configured — cannot verify CP assertion`
    );
    return c.json({ error: "Pod misconfigured (PUBLIC_URL)" }, 500);
  }
  if (!authToken) {
    return c.json({ error: "unauthorized", reason: "missing_assertion" }, 401);
  }
  const claims = await verifyTrustedIssuerJwt<Record<string, unknown>>(
    authToken,
    { audience }
  );
  if (!claims) {
    logger.warn(
      `mcp/${purposeClaim}: CP assertion failed trusted-issuer verification`
    );
    return c.json({ error: "unauthorized", reason: "invalid_assertion" }, 401);
  }
  // Defense in depth: the assertion must have been minted FOR this purpose, so
  // a CP JWT signed for the other route can't be replayed here.
  if (claims[purposeClaim] !== true) {
    logger.warn(
      `mcp/${purposeClaim}: CP assertion not scoped to ${purposeClaim}`
    );
    return c.json({ error: "unauthorized", reason: "wrong_purpose" }, 401);
  }
  return null;
}

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
    // This route is in `skipAuthPaths`, so the key-format middleware does NOT
    // run — see `verifyCpAssertion` above for the CP-trusted-issuer auth block.
    // The one-time `code` below is the SECOND required credential.
    const authFailure = await verifyCpAssertion(c, "mcp_redeem");
    if (authFailure) return authFailure;

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

  // ── POST /mcp/revoke ───────────────────────────────────────────────────────
  //
  // Server-to-server counterpart to /mcp/redeem: the CP calls this on
  // disconnect to kill the claude-web key it holds encrypted (rather than the
  // broken `apiKeys.delete` tRPC call via the CP's non-`synap_*` bootstrap
  // secret — see connect-mcp.ts `revokeGrant`). Idempotent and side-channel-
  // safe: an unknown/foreign/already-revoked keyId all collapse to
  // `{ revoked: false }`, 200 — never a 4xx that would let a caller distinguish
  // "doesn't exist" from "isn't yours" from "already gone".
  app.post("/mcp/revoke", async (c) => {
    const authFailure = await verifyCpAssertion(c, "mcp_revoke");
    if (authFailure) return authFailure;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const keyId =
      typeof (body as Record<string, unknown>).keyId === "string"
        ? ((body as Record<string, unknown>).keyId as string).trim()
        : "";
    if (!keyId) {
      return c.json({ error: "keyId is required" }, 400);
    }

    const keyRow = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, keyId),
      columns: { id: true, userId: true, revokedAt: true },
    });
    if (!keyRow) {
      // Unknown keyId — never leak existence, just report not-revoked.
      return c.json({ revoked: false });
    }
    if (keyRow.revokedAt) {
      // Already revoked — safely retryable, still 200.
      return c.json({ revoked: false });
    }

    // SECURITY FLOOR: only revoke a key that is plausibly an MCP-connect
    // claude-web agent key — i.e. its owner is the pod-wide `claude-web` agent
    // user minted by `provisionSurfaceAgentKey` in /mcp/redeem above (userType
    // "agent", agentType "claude-web"). This stops a CP assertion (scoped only
    // to `mcp_revoke`, not to a specific pod user) from being used to kill an
    // arbitrary pod key by guessing/leaking a keyId — the floor this schema CAN
    // express. It does NOT confine to the specific (podUserId, instanceId) pair
    // the CP's grant row names, because `api_keys` carries no direct link back
    // to a `pod_mcp_grants` row on the CP side to check against; agentType is
    // the tightest check available from the pod's own schema.
    const owner = await db.query.users.findFirst({
      where: eq(users.id, keyRow.userId),
      columns: { userType: true, agentType: true },
    });
    if (owner?.userType !== "agent" || owner.agentType !== "claude-web") {
      logger.warn(
        { keyId },
        "mcp/revoke: keyId does not belong to a claude-web agent — refusing to revoke"
      );
      return c.json({ revoked: false });
    }

    try {
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
      // revokedBy = the key's own owner (the agent user) — there is no human
      // actor in this CP-triggered flow, mirroring the same convention
      // `provisionSurfaceAgentKey`'s revoke+mint step uses (revokedBy: agentUserId).
      await apiKeyRepo.revoke(keyId, keyRow.userId, "CP-MCP disconnect");
      logger.info({ keyId }, "mcp/revoke: claude-web agent key revoked");
      return c.json({ revoked: true });
    } catch (err) {
      logger.error({ err, keyId }, "mcp/revoke: revoke failed");
      return c.json({ error: "Internal server error" }, 500);
    }
  });
}
