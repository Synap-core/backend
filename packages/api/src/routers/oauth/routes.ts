/**
 * The pod as its OWN OAuth 2.1 authorization server — HTTP surface (Path B).
 *
 * Path A puts the control plane in claude.ai's trust path: the CP is the AS, and
 * a consent code redeemed server-to-server mints the pod key (see
 * hub-protocol/rest/mcp-redeem.ts). Path B removes the CP entirely — a pod owner
 * points claude.ai straight at `https://<pod>/mcp` and this module serves the
 * whole flow. Both paths stay live; they are separable by the agentType they
 * mint (`claude-web` vs `claude-web-direct`).
 *
 * Discovery chain claude.ai walks:
 *   1. POST <pod>/mcp with no token         → 401 + WWW-Authenticate:
 *                                             Bearer resource_metadata="…"
 *   2. GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   3. GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   4. POST /register                       (RFC 7591 DCR)
 *   5. GET  /authorize  → pod-admin consent → back with ?code=
 *   6. POST /token      (PKCE S256 verifier enforced)
 *
 * NOTE: the SDK's own OAuth helpers (`@modelcontextprotocol/sdk` 1.29.0,
 * `server/auth/*`) are Express-shaped — they take `express.RequestHandler` and
 * mutate `res`. The pod is Hono, so they are unusable here and this module
 * implements the endpoints directly against the pure protocol layer in
 * `protocol.ts`.
 *
 * THE ACCESS TOKEN IS AN `api_keys` ROW. The pod has exactly one bearer model
 * and this endpoint does not invent a second one: /token mints through
 * `provisionSurfaceAgentKey`, the same door Path A uses, and returns the
 * plaintext key as `access_token`. That is why `/mcp` needs no OAuth-specific
 * auth branch — the token it receives is a key the existing middleware already
 * understands.
 */

import { Hono } from "hono";
import { createLogger } from "@synap-core/core";

import { provisionSurfaceAgentKey } from "../../services/agent-identity-service.js";
import { AGENT_KEY_TTL_DAYS } from "../../services/hub-integration-registration.js";
import { mapCpScopesToPodScopes } from "../hub-protocol/rest/mcp-redeem.js";
import { configuredPodAdminConsentUrl } from "../../utils/pod-admin-url.js";
import {
  OAUTH_AGENT_TYPE,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_SUPPORTED_SCOPES,
  resolveIssuer,
} from "./config.js";
import {
  AuthorizeUserError,
  resolveClientAndRedirect,
  validateAuthorizeRequest,
} from "./consent.js";
import {
  DcrError,
  OAuthError,
  buildAuthorizationServerMetadata,
  buildDcrResponse,
  buildProtectedResourceMetadata,
  isRegisteredRedirectUri,
  validateDcrRequest,
  verifyPkce,
} from "./protocol.js";
import { claimAuthorizationCode, findClient, insertClient } from "./store.js";

/** See the `: any` rationale in hub-protocol/rest/_shared.ts (TS2742). */
const logger: any = createLogger({ module: "pod-oauth" });

const oauthApp = new Hono();

/**
 * An AS that cannot name itself canonically must not serve metadata at all, so
 * a missing/invalid `PUBLIC_URL` disables every endpoint with a 503 rather than
 * falling back to the request's Host header — which is attacker-controlled, and
 * would let a Host-spoofed request mint a document pointing at another origin.
 */
const ISSUER_UNCONFIGURED = {
  error: "server_error",
  error_description: "This pod is not configured with a canonical PUBLIC_URL",
} as const;

function issuerOr503(): string | null {
  const issuer = resolveIssuer();
  if (!issuer) {
    logger.error(
      "pod-oauth: PUBLIC_URL is unset or not canonical — OAuth endpoints disabled"
    );
  }
  return issuer;
}

// ─── RFC 9728 — protected resource metadata ──────────────────────────────────
//
// Registered at BOTH the bare path and the `/mcp`-suffixed path. RFC 9728 §3.1
// inserts the resource's path component after the well-known segment, and MCP
// clients differ on which form they probe; serving both costs nothing and is the
// difference between discovery working and silently dead-ending.

oauthApp.get("/.well-known/oauth-protected-resource", (c) => {
  const issuer = issuerOr503();
  if (!issuer) return c.json(ISSUER_UNCONFIGURED, 503);
  return c.json(buildProtectedResourceMetadata(issuer, OAUTH_SUPPORTED_SCOPES));
});
oauthApp.get("/.well-known/oauth-protected-resource/mcp", (c) => {
  const issuer = issuerOr503();
  if (!issuer) return c.json(ISSUER_UNCONFIGURED, 503);
  return c.json(buildProtectedResourceMetadata(issuer, OAUTH_SUPPORTED_SCOPES));
});

// ─── RFC 8414 — authorization server metadata ────────────────────────────────

oauthApp.get("/.well-known/oauth-authorization-server", (c) => {
  const issuer = issuerOr503();
  if (!issuer) return c.json(ISSUER_UNCONFIGURED, 503);
  return c.json(
    buildAuthorizationServerMetadata(issuer, OAUTH_SUPPORTED_SCOPES)
  );
});
oauthApp.get("/.well-known/oauth-authorization-server/mcp", (c) => {
  const issuer = issuerOr503();
  if (!issuer) return c.json(ISSUER_UNCONFIGURED, 503);
  return c.json(
    buildAuthorizationServerMetadata(issuer, OAUTH_SUPPORTED_SCOPES)
  );
});

// ─── RFC 7591 — dynamic client registration ──────────────────────────────────
//
// PUBLIC and unauthenticated, which is what the spec requires for an open DCR
// endpoint and what claude.ai needs (it registers before any user is known). The
// exposure is bounded: a registration grants NOTHING on its own — the resulting
// client_id can only ever reach a consent screen that a signed-in human must
// approve, and the redirect_uris it may ever receive a code at are frozen at
// registration time and https-only.
oauthApp.post("/register", async (c) => {
  if (!issuerOr503()) return c.json(ISSUER_UNCONFIGURED, 503);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "Request body must be a JSON object",
      },
      400
    );
  }

  let metadata;
  try {
    metadata = validateDcrRequest(
      body as Record<string, unknown>,
      OAUTH_SUPPORTED_SCOPES,
      OAUTH_DEFAULT_SCOPES
    );
  } catch (err) {
    if (err instanceof DcrError) return c.json(err.toJSON(), 400);
    throw err;
  }

  const { clientId, createdAt } = await insertClient(metadata);
  logger.info(
    { clientId, clientName: metadata.clientName },
    "pod-oauth: client registered"
  );
  // RFC 7591 §3.2.1 — 201 Created.
  return c.json(buildDcrResponse(clientId, metadata, createdAt), 201);
});

// ─── /authorize ──────────────────────────────────────────────────────────────
//
// Validates the request, then hands the browser to pod-admin's consent screen.
// This endpoint deliberately does NOT authenticate the human: the pod API and
// pod-admin are different origins, and pod-admin already owns a Kratos-gated
// sign-in surface that bounces through `/login?return=…`. Duplicating that here
// would be a second auth path to keep correct.
oauthApp.get("/authorize", async (c) => {
  if (!issuerOr503()) {
    return c.text(
      "This pod is not configured with a canonical PUBLIC_URL",
      503
    );
  }
  const q = c.req.query();
  const params = {
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    responseType: q.response_type,
    scope: q.scope,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
  };

  // ── Phase 1: client + redirect_uri. RFC 6749 §4.1.2.1 — errors here are shown
  // to the user and MUST NOT be redirected (there is no verified URI yet).
  let client, redirectUri: string;
  try {
    ({ client, redirectUri } = await resolveClientAndRedirect(params));
  } catch (err) {
    if (err instanceof AuthorizeUserError) {
      return c.text(`Authorization request rejected: ${err.message}`, 400);
    }
    throw err;
  }

  // ── Phase 2: everything else redirects the error back to the client.
  let validated;
  try {
    validated = validateAuthorizeRequest(client, redirectUri, params);
  } catch (err) {
    if (err instanceof OAuthError) {
      const back = new URL(redirectUri);
      back.searchParams.set("error", err.code);
      back.searchParams.set("error_description", err.message);
      if (params.state) back.searchParams.set("state", params.state);
      return c.redirect(back.toString(), 302);
    }
    throw err;
  }

  const consent = configuredPodAdminConsentUrl();
  if (!consent.ok) {
    logger.error(
      { code: consent.code },
      "pod-oauth: POD_ADMIN_URL not configured — cannot show consent"
    );
    return c.text(
      "This pod is not configured with a Pod Admin URL, so it cannot show an authorization consent screen.",
      503
    );
  }

  // Forward the VALIDATED parameters. The consent surface re-resolves all of
  // them server-side before minting anything (see consent.ts), so this URL is a
  // convenience, never a trusted assertion.
  const target = consent.url;
  target.searchParams.set("client_id", validated.client.clientId);
  target.searchParams.set("redirect_uri", validated.redirectUri);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", validated.grantedScopes.join(" "));
  target.searchParams.set("code_challenge", validated.codeChallenge);
  target.searchParams.set("code_challenge_method", "S256");
  if (validated.state) target.searchParams.set("state", validated.state);

  return c.redirect(target.toString(), 302);
});

// ─── /token ──────────────────────────────────────────────────────────────────

/**
 * RFC 6749 §4.1.3 mandates `application/x-www-form-urlencoded`. JSON is also
 * accepted because some MCP clients send it, and rejecting a request whose
 * meaning is unambiguous would break a flow for no security gain.
 */
async function readTokenParams(
  raw: string,
  contentType: string
): Promise<Record<string, string>> {
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

oauthApp.post("/token", async (c) => {
  // RFC 6749 §5.1 — a token response must never be cached.
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!issuerOr503()) return c.json(ISSUER_UNCONFIGURED, 503);

  let params: Record<string, string>;
  try {
    params = await readTokenParams(
      await c.req.text(),
      c.req.header("content-type") ?? ""
    );
  } catch {
    return c.json(
      { error: "invalid_request", error_description: "Malformed request body" },
      400
    );
  }

  try {
    if (params.grant_type !== "authorization_code") {
      throw new OAuthError(
        "unsupported_grant_type",
        'Only grant_type "authorization_code" is supported'
      );
    }
    if (!params.code) {
      throw new OAuthError("invalid_request", "code is required");
    }
    if (!params.client_id) {
      throw new OAuthError("invalid_request", "client_id is required");
    }

    // CLAIM FIRST. The claim is a single atomic UPDATE that consumes the code,
    // so the checks below run on an already-burned code: a wrong verifier or a
    // mismatched redirect_uri does not leave a retryable code behind, and two
    // concurrent exchanges can never both win the row.
    const claimed = await claimAuthorizationCode(params.code);
    if (!claimed) {
      // Missing / expired / already-consumed collapse to one message — never
      // leak which codes exist or why this one failed.
      throw new OAuthError(
        "invalid_grant",
        "Invalid, expired, or already-redeemed authorization code"
      );
    }

    // The code is bound to the client that requested it (RFC 6749 §4.1.3).
    if (claimed.clientId !== params.client_id) {
      logger.warn(
        { expected: claimed.clientId, got: params.client_id },
        "pod-oauth: token exchange with mismatched client_id"
      );
      throw new OAuthError(
        "invalid_grant",
        "client_id does not match the code"
      );
    }

    // §4.1.3 requires redirect_uri to be identical to the authorize request's.
    // Re-checked against the client's registered list too, so a client whose
    // registration changed cannot redeem against a URI it no longer owns.
    const client = await findClient(claimed.clientId);
    if (!client) {
      throw new OAuthError("invalid_client", "Unknown client");
    }
    if (
      params.redirect_uri !== claimed.redirectUri ||
      !isRegisteredRedirectUri(client.redirectUris, claimed.redirectUri)
    ) {
      throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    }

    // PKCE. Throws on absent, malformed, or mismatched verifier — there is no
    // branch where a missing challenge means "skip the check".
    verifyPkce(claimed.codeChallenge, params.code_verifier);

    // ── Mint the access token: an `api_keys` row, via the ONE door. ──────────
    //
    // `linkedUserId` is the consenting human and is LOAD-BEARING, not
    // bookkeeping: `http-handler.ts` derives
    //   agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined
    // and a DEFINED agentUserId is the only thing that routes an MCP write
    // through the governance membrane into a proposal. Drop it and every Claude
    // write silently auto-applies with the operator's authority — no error, no
    // signal, governance bypassed.
    const scopes = mapCpScopesToPodScopes(claimed.scopes);
    const provisioned = await provisionSurfaceAgentKey({
      agentType: OAUTH_AGENT_TYPE,
      createdByUserId: claimed.userId,
      linkedUserId: claimed.userId,
      // Sibling revocation inside provisionSurfaceAgentKey is instance-scoped.
      // Keying the instance on (client, human) means re-authorizing rotates
      // exactly this connection's key and never kills another human's — agent
      // USERs are singleton per (createdByUserId, agentType), and instanceId
      // further isolates multi-runtime keys for the same human.
      instanceId: `oauth:${claimed.clientId}:${claimed.userId}`,
      scopes,
      ensureRegistryRow: true,
      agentLabel: "Claude (Web, direct)",
      keyName: "Claude Web Direct Hub Key",
      keyDescription:
        "Hub Protocol auth token for claude-web-direct MCP agent — issued by the pod's own OAuth authorization server",
      agentDescription:
        "Claude (claude.ai web) — external MCP agent, connected directly to this pod",
      logger,
    });

    // We never pass `idempotent`, so this door always revokes+mints and returns
    // fresh plaintext. If it ever short-circuits we have no usable key to return
    // — fail loudly rather than hand back a broken token response.
    if (provisioned.alreadyValid) {
      logger.error(
        { agentUserId: provisioned.agentUserId },
        "pod-oauth: unexpected alreadyValid — no fresh key to return"
      );
      throw new OAuthError("server_error", "Token minting returned no key");
    }
    if (provisioned.registration.outcome !== "CONNECTED_VERIFIED") {
      logger.error(
        {
          agentUserId: provisioned.agentUserId,
          verificationError: provisioned.registration.verificationError,
        },
        "pod-oauth: key minted but verification failed"
      );
      throw new OAuthError(
        "server_error",
        "Token minted but failed verification"
      );
    }

    const expiresAt = provisioned.apiKey?.expiresAt;
    const expiresIn =
      expiresAt instanceof Date
        ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
        : AGENT_KEY_TTL_DAYS * 24 * 60 * 60;

    logger.info(
      {
        clientId: claimed.clientId,
        podUserId: claimed.userId,
        keyId: provisioned.keyId,
        agentUserId: provisioned.agentUserId,
        scopes,
      },
      "pod-oauth: access token issued"
    );

    return c.json({
      access_token: provisioned.plainKey,
      token_type: "Bearer",
      expires_in: expiresIn,
      // Echo the granted scopes in the grammar the key actually carries.
      scope: scopes.join(" "),
    });
  } catch (err) {
    if (err instanceof OAuthError) {
      // RFC 6749 §5.2: invalid_client → 401, server_error → 500, rest → 400.
      const status =
        err.code === "invalid_client"
          ? 401
          : err.code === "server_error"
            ? 500
            : 400;
      return c.json(err.toJSON(), status);
    }
    logger.error({ err }, "pod-oauth: token endpoint failed");
    return c.json(
      { error: "server_error", error_description: "Internal server error" },
      500
    );
  }
});

export { oauthApp };
