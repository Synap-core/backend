/**
 * The pod as its OWN OAuth 2.1 authorization server — HTTP surface (Path B).
 *
 * Founder decision 6 (2026-10-15): this AS is the ONE door that mints MCP
 * credentials for this pod. Two kinds of client use it:
 *   - a direct client (claude.ai, Cursor…) pointed at `https://<pod>/mcp`
 *     → agentType `claude-web-direct`;
 *   - the Control Plane's MCP connector, an OAuth client of this AS whose
 *     redirect_uri sits on the approved Control Plane's origin → `claude-web`
 *     (see `resolveOAuthAgentType`, config.ts);
 *   - "Sign in with Synap" (founder A1, 2026-10-20): an app registered AND
 *     approved on this pod, client_id = its `public_id`, redirect_uris set by
 *     its owner → a token HELD BY THE SIGNING-IN PERSON, bounded by the app's
 *     grant (services/app-person-token.ts).
 * The legacy consent-code path (hub-protocol/rest/mcp-redeem.ts) still mints
 * `claude-web` until the CP moves onto this AS; it is retired after that.
 *
 * Discovery chain claude.ai walks:
 *   1. POST <pod>/mcp with no token         → 401 + WWW-Authenticate:
 *                                             Bearer resource_metadata="…"
 *   2. GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   3. GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   4. POST /register                       (RFC 7591 DCR)
 *   5. GET  /authorize  → pod-admin consent → back with ?code=
 *   6. POST /token      (PKCE S256 verifier enforced)
 *   7. POST /revoke     (RFC 7009 — the holder of a key retires it)
 *
 * A pod app (CIMD client, spec 17) walks 5–7 too, and its /token answer adds a
 * rotating refresh token (`grant_type=refresh_token`, refresh.ts). An MCP
 * (DCR) client never gets one: its key lives 90 days. An MCP client may name a
 * metadata document instead of registering (one that declares no
 * `synap_requests`, `isMcpClient`): it is an MCP client in every respect.
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

import { randomUUID } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";

import { db, eq, users } from "@synap/database";
import { APP_PERSON_KEY_TYPE } from "@synap/database/schema";

import { TRPCError } from "@trpc/server";

import { provisionSurfaceAgentKey } from "../../services/agent-identity-service.js";
import {
  isPodAppAgent,
  mintAppOAuthAccessKey,
  reuseAppOAuthAccessKey,
  type AppOAuthAccessKey,
} from "../../services/app-connect.js";
import { apiKeyService } from "../../services/api-keys.js";
import { AGENT_KEY_TTL_DAYS } from "../../services/hub-integration-registration.js";
import {
  configuredPodAdminBase,
  configuredPodAdminConsentUrl,
} from "../../utils/pod-admin-url.js";
import {
  CP_CONNECTOR_AGENT_TYPE,
  OAUTH_DEFAULT_SCOPES,
  OAUTH_REVOCABLE_AGENT_TYPES,
  OAUTH_SUPPORTED_SCOPES,
  mapCpScopesToPodScopes,
  oauthKeyInstanceId,
  parseOauthKeyInstanceId,
  resolveIssuer,
  resolveOAuthAgentType,
  type OAuthAgentType,
} from "./config.js";
import {
  AuthorizeUserError,
  isMcpClient,
  resolveClientAndRedirect,
  resourceFor,
  validateAuthorizeRequest,
} from "./consent.js";
import {
  DcrError,
  OAuthError,
  buildAuthorizationResponseUrl,
  buildAuthorizationServerMetadata,
  buildDcrResponse,
  buildProtectedResourceMetadata,
  isRegisteredRedirectUri,
  validateDcrRequest,
  verifyPkce,
} from "./protocol.js";
import {
  RefreshTokenReuseError,
  confirmGraceSuccessor,
  findRefreshToken,
  redeemRefreshToken,
  releaseRefreshClaim,
  revokeRefreshFamily,
  rotateRefreshToken,
  startRefreshFamily,
  successorAccessToken,
  type RedeemedRefreshToken,
} from "./refresh.js";
import { claimAuthorizationCode, findClient, insertClient } from "./store.js";
import { logOAuthRefusal } from "./refusal-log.js";
import { renderAuthorizeRefusalPage } from "./refusal-page.js";
import {
  APP_PERSON_SCOPES,
  isAppClientId,
  resolveAppClient,
} from "./app-client.js";

/** See the `: any` rationale in hub-protocol/rest/_shared.ts (TS2742). */
const logger: any = createLogger({ module: "pod-oauth" });

/**
 * What the minted agent and key are called, per agentType. The CP connector's
 * labels are the ones the legacy consent-code path writes, so the agent user
 * (singleton per human × agentType) reads the same whichever door minted it.
 */
const MINT_LABELS: Record<
  OAuthAgentType,
  {
    agentLabel: string;
    keyName: string;
    keyDescription: string;
    agentDescription: string;
  }
> = {
  "claude-web-direct": {
    agentLabel: "Claude (Web, direct)",
    keyName: "Claude Web Direct Hub Key",
    keyDescription:
      "Hub Protocol auth token for claude-web-direct MCP agent — issued by the pod's own OAuth authorization server",
    agentDescription:
      "Claude (claude.ai web) — external MCP agent, connected directly to this pod",
  },
  [CP_CONNECTOR_AGENT_TYPE]: {
    agentLabel: "Claude (Web)",
    keyName: "Claude Web Hub Key",
    keyDescription:
      "Hub Protocol auth token for claude-web MCP agent — issued by the pod's own OAuth authorization server to the Synap Control Plane connector",
    agentDescription: "Claude (claude.ai web) — external MCP agent",
  },
};

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
  const issuer = issuerOr503();
  if (!issuer) {
    return c.text(
      "This pod is not configured with a canonical PUBLIC_URL",
      503
    );
  }
  const q = c.req.query();
  const resources = c.req.queries("resource") ?? [];
  const params = {
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    responseType: q.response_type,
    scope: q.scope,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    resource: resources[0],
  };

  // ── Phase 1: client + redirect_uri. RFC 6749 §4.1.2.1 — errors here are shown
  // to the user and MUST NOT be redirected (there is no verified URI yet).
  let client, redirectUri: string;
  try {
    ({ client, redirectUri } = await resolveClientAndRedirect(params));
  } catch (err) {
    if (err instanceof AuthorizeUserError) {
      logOAuthRefusal({
        phase: "authorize",
        clientId: params.clientId,
        reason: err.reason,
        detail: err.message,
      });
      return c.html(
        renderAuthorizeRefusalPage({
          podHost: new URL(issuer).host,
          reason: err.reason,
          message: err.message,
        }),
        400,
        { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
      );
    }
    throw err;
  }

  // ── Phase 2: everything else redirects the error back to the client, with
  // `iss` like every authorization response (RFC 9207).
  let validated;
  try {
    if (resources.length > 1) {
      // RFC 8707 allows several; a token from this AS is for one pod resource.
      // An app is refused; an MCP client gets the lenient rule (`resourceFor`).
      if (!isMcpClient(client)) {
        throw new OAuthError("invalid_target", "Name at most one resource");
      }
      params.resource = resources.join(" ");
    }
    validated = validateAuthorizeRequest(client, redirectUri, params);
    if (validated.ignoredResource !== null) {
      // The value claude.ai (or any DCR client) really sends — the evidence
      // the lenient rule waits on. Public request data, no secret.
      logger.warn(
        { clientId: client.clientId, resource: validated.ignoredResource },
        "pod-oauth: unrecognised resource from a DCR client — treated as absent"
      );
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      logOAuthRefusal({
        phase: "authorize",
        clientId: client.clientId,
        reason: err.code,
        code: err.code,
        detail: err.message,
      });
      return c.redirect(
        buildAuthorizationResponseUrl(redirectUri, issuer, {
          error: err.code,
          error_description: err.message,
          state: params.state || null,
        }),
        302
      );
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
      "This pod is not configured with a Pod Console URL, so it cannot show an authorization consent screen.",
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
  if (validated.resource) {
    target.searchParams.set("resource", validated.resource);
  }

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

/** A connection's key-door arguments: the app, the person, the key slot. */
function appKeyArgs(connection: {
  clientId: string;
  userId: string;
  appId: string;
}) {
  return {
    appId: connection.appId,
    ownerUserId: connection.userId,
    oauthClientId: connection.clientId,
    instanceId: oauthKeyInstanceId(connection.clientId, connection.userId),
  };
}

/** Revoked, nothing approved, not this person's connection: `invalid_grant`. */
async function asGrantRefusal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TRPCError && err.code !== "INTERNAL_SERVER_ERROR") {
      throw new OAuthError("invalid_grant", err.message);
    }
    throw err;
  }
}

/**
 * A pod app's access key for a connection: re-derived from the connection's
 * CURRENT approval every time (`mintAppOAuthAccessKey`). Revoked, nothing
 * approved, not this person's connection: the grant is gone (`invalid_grant`).
 * `plainKey`: a refresh's key is its successor's (`successorAccessToken`).
 */
async function mintAppKey(
  connection: { clientId: string; userId: string; appId: string },
  plainKey?: string
): Promise<AppOAuthAccessKey> {
  return asGrantRefusal(() =>
    mintAppOAuthAccessKey(
      plainKey
        ? { ...appKeyArgs(connection), plainKey }
        : appKeyArgs(connection)
    )
  );
}

/** A pod app's token response (spec 17 §6.6), for a code and a refresh alike. */
function appTokenResponse(minted: AppOAuthAccessKey, refreshToken: string) {
  return {
    access_token: minted.accessToken,
    token_type: "Bearer",
    expires_in: Math.max(
      0,
      Math.floor((minted.expiresAt.getTime() - Date.now()) / 1000)
    ),
    refresh_token: refreshToken,
    scope: [...new Set(minted.grant.map((g) => g.permission))].join(" "),
    // Synap extension (spec 17 §6.6): what the token reaches and for whom,
    // so the app can say "Connected as …" without another call.
    synap_grant: minted.grant,
    synap_user: minted.user,
    // Which app this connection is on the pod, and the pod-admin page where
    // the person narrows or revokes it (null: no valid POD_ADMIN_URL).
    synap_app: {
      id: minted.publicId,
      manageUrl: appManageUrl(minted.publicId),
    },
  };
}

/** The pod-admin page of one app (`/apps/[publicId]`), or null if unconfigured. */
function appManageUrl(publicId: string): string | null {
  const admin = configuredPodAdminBase();
  if (!admin.ok) return null;
  return new URL(
    `/apps/${encodeURIComponent(publicId)}`,
    admin.base
  ).toString();
}

/**
 * `grant_type=refresh_token` (RFC 6749 §6), pod apps only: redeem the token
 * (single-use; a reuse revokes its family and the live key), mint a key from
 * the connection's CURRENT approval, then issue the successor. A `scope`
 * parameter is ignored: what the key reaches is the approval, never the
 * request. Every refusal of the token itself is one `invalid_grant`.
 */
async function exchangeAppRefreshToken(
  params: Record<string, string>,
  issuer: string
) {
  if (!params.refresh_token) {
    throw new OAuthError("invalid_request", "refresh_token is required");
  }
  if (!params.client_id) {
    throw new OAuthError("invalid_request", "client_id is required");
  }
  const client = await findClient(params.client_id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client");
  if (client.clientKind !== "cimd") {
    // An MCP (DCR) client is issued no refresh token (spec 17 §6.6). One that
    // came by CIMD gets none either: a family is only ever started for an
    // approved connection, so its presented token redeems to nothing.
    throw new OAuthError(
      "unauthorized_client",
      "This client may not use the refresh_token grant"
    );
  }
  // RFC 8707: a `resource` on a refresh must name this pod (strict for an
  // app), checked before the token is spent. A pod key is not bound to one of
  // the pod's resources, so the row keeps none to compare.
  if (params.resource !== undefined) {
    resourceFor(client, params.resource, issuer);
  }
  let redeemed;
  try {
    redeemed = await redeemRefreshToken(params.refresh_token, client.clientId);
    if (redeemed.grace) {
      return await refreshWithinGrace({ ...redeemed, grace: redeemed.grace });
    }
  } catch (err) {
    if (err instanceof RefreshTokenReuseError) {
      logger.warn(
        { clientId: client.clientId, familyId: err.familyId },
        "pod-oauth: refresh token reused — its family and the live key are revoked"
      );
    }
    throw err;
  }
  // The successor's id first: the key is the one it re-derives (the grace).
  const successorId = randomUUID();
  let minted: AppOAuthAccessKey;
  let refreshToken: string;
  try {
    minted = await mintAppKey(redeemed, successorAccessToken(successorId));
    refreshToken = await rotateRefreshToken(redeemed, successorId);
  } catch (err) {
    // A refusal of the grant (revoked, emptied, family dead) keeps the token
    // spent. Anything else is the pod's fault: the claim is undone so the
    // app's retry works, instead of reading as a reuse.
    if (!(err instanceof OAuthError) || err.code === "server_error") {
      await releaseRefreshClaim(redeemed).catch((releaseErr) =>
        logger.error(
          { err: releaseErr, clientId: client.clientId },
          "pod-oauth: a failed refresh could not release its token's claim"
        )
      );
    }
    throw err;
  }
  logger.info(
    {
      clientId: client.clientId,
      podUserId: redeemed.userId,
      keyId: minted.keyId,
      agentUserId: minted.agentUserId,
      appId: minted.publicId,
    },
    "pod-oauth: pod app access token refreshed"
  );
  return appTokenResponse(minted, refreshToken);
}

/**
 * The reuse grace (spec 17 PB3b, refresh.ts): a spent token presented again
 * with its own client_id within the grace gets the SAME pair its first use
 * got: its successor refresh token (unrotated, its expiry untouched) and the live
 * key that came with it, re-granted from the CURRENT approval. So parallel
 * instances of one app end up holding one working pair, and no copy is
 * revoked by another. Only when that key is no longer the slot's live key, or
 * the approval now needs other scopes, is a key minted (PB2 rules, same
 * slot). Then the successor is confirmed still unspent and live, or the
 * answer is refused as a reuse.
 */
async function refreshWithinGrace(
  redeemed: RedeemedRefreshToken & {
    grace: NonNullable<RedeemedRefreshToken["grace"]>;
  }
) {
  const accessToken = successorAccessToken(redeemed.grace.successorId);
  const reused = await asGrantRefusal(() =>
    reuseAppOAuthAccessKey({ ...appKeyArgs(redeemed), accessToken })
  );
  const key = reused ?? (await mintAppKey(redeemed));
  await confirmGraceSuccessor(redeemed);
  logger.info(
    {
      clientId: redeemed.clientId,
      podUserId: redeemed.userId,
      familyId: redeemed.familyId,
      keyId: key.keyId,
      keyReused: reused !== null,
      appId: key.publicId,
    },
    "pod-oauth: refresh token presented again within the reuse grace — same pair answered"
  );
  return appTokenResponse(key, redeemed.grace.refreshToken);
}

oauthApp.post("/token", async (c) => {
  // RFC 6749 §5.1 — a token response must never be cached.
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  const issuer = issuerOr503();
  if (!issuer) return c.json(ISSUER_UNCONFIGURED, 503);

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
    if (params.grant_type === "refresh_token") {
      return c.json(await exchangeAppRefreshToken(params, issuer));
    }
    if (params.grant_type !== "authorization_code") {
      throw new OAuthError(
        "unsupported_grant_type",
        'Only grant_type "authorization_code" or "refresh_token" is supported'
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
    // A sign-in app is re-resolved from `apps`: revoked, unapproved or with
    // the URI removed since consent → no client, no token.
    const client = isAppClientId(claimed.clientId)
      ? await resolveAppClient(claimed.clientId)
      : await findClient(claimed.clientId);
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

    // RFC 8707 §2.2: a code bound to a resource accepts only that resource.
    // Otherwise an app is held to the strict rule, and a DCR client's
    // unrecognised value reads as absent (`resourceFor`) — which still fails
    // the match below when the code IS bound.
    if (params.resource !== undefined) {
      const resource = resourceFor(client, params.resource, issuer).resource;
      if (claimed.resource && resource !== claimed.resource) {
        throw new OAuthError(
          "invalid_target",
          "resource does not match the authorization request"
        );
      }
    }

    // "Sign in with Synap" (A1): a registered, approved app's code mints a
    // token HELD BY THE PERSON, never an agent key — the one door, which
    // states the threat model (services/app-person-token.ts).
    if (client.clientKind === "app") {
      // Loaded on use: the mint pulls the app + grant services, which the
      // protocol endpoints (and their tests) otherwise never need.
      const { mintAppPersonToken } =
        await import("../../services/app-person-token.js");
      const minted = await mintAppPersonToken({
        publicId: client.clientId,
        personUserId: claimed.userId,
        consented: claimed.appGrant ?? [],
      });
      if (!minted.ok) {
        logger.warn(
          { clientId: claimed.clientId, reason: minted.reason },
          "pod-oauth: app sign-in refused at mint"
        );
        throw new OAuthError(
          "invalid_grant",
          minted.reason === "app_unavailable"
            ? "This app can no longer sign anyone in"
            : minted.reason === "not_for_you"
              ? "This app may only sign in the member who registered it"
              : "Nothing is left of what was approved — sign in again"
        );
      }
      logger.info(
        {
          clientId: claimed.clientId,
          podUserId: claimed.userId,
          keyId: minted.keyId,
        },
        "pod-oauth: app sign-in token issued"
      );
      return c.json({
        access_token: minted.plainKey,
        token_type: "Bearer",
        expires_in: Math.max(
          0,
          Math.floor((minted.expiresAt.getTime() - Date.now()) / 1000)
        ),
        scope: APP_PERSON_SCOPES.join(" "),
      });
    }

    // A pod app (CIMD client) is NEVER minted the shared `claude-web*` agent
    // (spec 17 I3): its key belongs to the app's OWN agent for this person,
    // carrying exactly what the person approved at consent, for 1 h. A code
    // that names an approved connection is always a pod app's, even if the
    // document has since dropped its `synap_requests`. Only a code naming
    // none, for a document that declares none, is an MCP client's (A1): it
    // falls through to the MCP mint below, like a DCR client's.
    if (
      client.clientKind === "cimd" &&
      (claimed.appId !== null || !isMcpClient(client))
    ) {
      if (!claimed.appId) {
        // A code from before PB2 (or a DCR-shaped issue) names no approval.
        throw new OAuthError(
          "invalid_grant",
          "This authorization names no approved app connection"
        );
      }
      const connection = {
        clientId: claimed.clientId,
        userId: claimed.userId,
        appId: claimed.appId,
      };
      const minted = await mintAppKey(connection);
      // A new family; the connection's older ones end (one live family per
      // connection, as it has one live key).
      const refreshToken = await startRefreshFamily(connection);
      logger.info(
        {
          clientId: claimed.clientId,
          podUserId: claimed.userId,
          keyId: minted.keyId,
          agentUserId: minted.agentUserId,
          appId: minted.publicId,
        },
        "pod-oauth: pod app access token issued"
      );
      return c.json(appTokenResponse(minted, refreshToken));
    }

    // ── Mint the access token: an `api_keys` row, via the ONE door. ──────────
    //
    // `linkedUserId` is the consenting human and is LOAD-BEARING, not
    // bookkeeping: `http-handler.ts` resolves identity via `resolveKeyIdentity`
    // (access/key-identity.ts), which derives `agentUserId` from the key
    // principal's `users.userType === 'agent'` — this OAuth-minted key's
    // principal IS an agent (a `claude-web*` agentType), so `agentUserId` is always
    // set. `linkedUserId` instead feeds `effectiveUserId` (`linkedUserId ??
    // userId`), the data floor the agent reads/writes as. Drop it here and
    // every Claude write silently acts as the AGENT's own identity instead of
    // the consenting human's — no error, no signal.
    const scopes = mapCpScopesToPodScopes(claimed.scopes);
    // CP connector vs direct client, by the origin the code was delivered to.
    // A registry read failure throws → server_error, never a silent guess.
    const agentType = await resolveOAuthAgentType(claimed.redirectUri);
    const provisioned = await provisionSurfaceAgentKey({
      agentType,
      createdByUserId: claimed.userId,
      linkedUserId: claimed.userId,
      // Sibling revocation inside provisionSurfaceAgentKey is instance-scoped.
      // Keying the instance on (client, human) means re-authorizing rotates
      // exactly this connection's key and never kills another human's — agent
      // USERs are singleton per (createdByUserId, agentType), and instanceId
      // further isolates multi-runtime keys for the same human.
      instanceId: oauthKeyInstanceId(claimed.clientId, claimed.userId),
      scopes,
      ensureRegistryRow: true,
      ...MINT_LABELS[agentType],
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
        agentType,
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
      if (err.code !== "server_error") {
        // The client_id only: the body holds the code, the refresh token and
        // the verifier, and none of them is ever logged.
        logOAuthRefusal({
          phase: params.grant_type === "refresh_token" ? "refresh" : "token",
          clientId: params.client_id,
          reason: err.code,
          code: err.code,
          detail: err.message,
        });
      }
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

// ─── /revoke (RFC 7009) ──────────────────────────────────────────────────────
//
// The holder of an access token retires it. Every client of this AS is public
// (no client secret), so POSSESSION of the token is the authority — the same
// authority that lets the holder use it. What it may reach is floored to the
// keys this AS mints: a `claude-web*` agent's key, or a person's app sign-in
// token (`app_person` — the app's "sign out"). Any other key is treated as
// unknown, so presenting a human PAT, an IS key or any other key here can
// never kill it.
//
// RFC 7009 §2.2: an invalid, unknown, expired or already-revoked token is a
// 200 too — the client's goal (the token is dead) is met, and the answer is no
// oracle for which tokens exist. A `client_id` that contradicts the client the
// key was minted for (`oauth:<clientId>:<user>` instance) is refused (§2.1).
// Keys minted by the legacy consent-code path (`mcp:` instance) carry no
// client binding, so possession alone retires them — that is how the Control
// Plane retires a grant it holds whichever door minted it.
//
// A pod app's REFRESH token is accepted too (spec 17 §6.7): its whole family
// and the connection's live access key are revoked. `token_type_hint` only
// orders the two lookups (§2.1): a miss on the hinted kind tries the other.

/**
 * The keys this AS mints, and so the only ones /revoke may retire: held by a
 * `claude-web*` agent (an MCP client), or by the agent of a pod app
 * connection (an `apps` row with mode 'oauth', `isPodAppAgent`).
 */
async function isOAuthMintedKey(
  keyUserId: string,
  owner: { userType: string | null; agentType: string | null } | undefined
): Promise<boolean> {
  if (owner?.userType !== "agent") return false;
  if (
    (OAUTH_REVOCABLE_AGENT_TYPES as readonly string[]).includes(
      owner.agentType ?? ""
    )
  ) {
    return true;
  }
  return isPodAppAgent(keyUserId);
}

const UNAUTHORIZED_REVOKE = {
  error: "unauthorized_client",
  error_description: "The token was not issued to this client",
} as const;

/**
 * Revoke `presented` if it is one of this AS's refresh tokens: "revoked",
 * "wrong_client" (bound to another client, §2.1), or null when it is not one.
 */
async function revokeAsRefreshToken(
  presented: string,
  clientId: string | undefined
): Promise<"revoked" | "wrong_client" | null> {
  const token = await findRefreshToken(presented);
  if (!token) return null;
  if (clientId && clientId !== token.clientId) {
    logger.warn(
      { familyId: token.familyId, clientId },
      "pod-oauth: /revoke of a refresh token by a client it was not issued to"
    );
    return "wrong_client";
  }
  await revokeRefreshFamily(token, "OAuth token revocation (RFC 7009)");
  logger.info(
    { familyId: token.familyId, clientId: token.clientId },
    "pod-oauth: refresh token family revoked"
  );
  return "revoked";
}

oauthApp.post("/revoke", async (c) => {
  c.header("Cache-Control", "no-store");
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
  const presented = params.token?.trim();
  if (!presented) {
    return c.json(
      { error: "invalid_request", error_description: "token is required" },
      400
    );
  }

  try {
    const refreshFirst = params.token_type_hint === "refresh_token";
    if (refreshFirst) {
      const done = await revokeAsRefreshToken(presented, params.client_id);
      if (done === "wrong_client") return c.json(UNAUTHORIZED_REVOKE, 400);
      if (done === "revoked") return c.body(null, 200);
    }
    const status = await apiKeyService.getApiKeyStatus(presented);
    // Only a LIVE key has anything to revoke; every other state is already the
    // outcome the client asked for — unless it is a refresh token.
    if (status.status !== "valid") {
      if (!refreshFirst) {
        const done = await revokeAsRefreshToken(presented, params.client_id);
        if (done === "wrong_client") return c.json(UNAUTHORIZED_REVOKE, 400);
      }
      return c.body(null, 200);
    }
    const key = status.record;

    const owner = await db.query.users.findFirst({
      where: eq(users.id, key.userId),
      columns: { userType: true, agentType: true },
    });
    // A person's app sign-in token (the app's "sign out") is this AS's too.
    const revocable =
      key.keyType === APP_PERSON_KEY_TYPE ||
      (await isOAuthMintedKey(key.userId, owner));
    if (!revocable) {
      logger.warn(
        { keyId: key.id },
        "pod-oauth: /revoke presented a key this AS does not mint — ignored"
      );
      return c.body(null, 200);
    }

    const boundClient =
      parseOauthKeyInstanceId(key.instanceId)?.clientId ?? null;
    if (boundClient && params.client_id && params.client_id !== boundClient) {
      logger.warn(
        { keyId: key.id, clientId: params.client_id },
        "pod-oauth: /revoke by a client the token was not issued to"
      );
      return c.json(UNAUTHORIZED_REVOKE, 400);
    }

    // The ONE revoke door (drops the verification cache, so the key stops
    // validating now). revokedBy = the key's own agent owner — no human acts
    // here, the same convention the legacy /mcp/revoke uses.
    await apiKeyService.revokeApiKey(
      key.id,
      key.userId,
      "OAuth token revocation (RFC 7009)"
    );
    logger.info(
      { keyId: key.id, agentType: owner?.agentType },
      "pod-oauth: access token revoked"
    );
    return c.body(null, 200);
  } catch (err) {
    logger.error({ err }, "pod-oauth: revoke endpoint failed");
    return c.json(
      { error: "server_error", error_description: "Internal server error" },
      500
    );
  }
});

export { oauthApp };
