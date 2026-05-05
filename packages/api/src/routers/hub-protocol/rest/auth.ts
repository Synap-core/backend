/**
 * Hub Protocol REST — auth introspection + JWT-Bearer token exchange.
 *
 * `GET /auth/status` — when called with a valid bearer key, returns the
 * introspection of that key (id, scopes, expiry, owning user). External
 * operators (Eve CLI, OpenClaw, custom integrations) use this to verify
 * what their key can do BEFORE attempting privileged calls.
 *
 * The endpoint is auth-gated by the same middleware as the rest of
 * `/api/hub/*` — there's no "ping with junk credentials and get a hint"
 * path, because that would leak which keys exist on the pod.
 *
 * `POST /auth/exchange` — RFC 7523 JWT-Bearer Grant. A trusted issuer
 * (e.g. Eve) presents a short-lived JWT vouching for one of its users; the
 * pod returns a Kratos session token so the user transparently signs in.
 * This endpoint is NOT API-key gated (it IS the auth primitive); auth
 * happens via the JWT signature + the trusted_issuers allowlist.
 */

import { createRoute } from "@hono/zod-openapi";
import jwt from "jsonwebtoken";
import { db, apiKeys, users, eq, TrustedIssuerService } from "@synap/database";

import { shortenKeyId } from "../../../utils/auth-error.js";
import { verifyCpJwt } from "../../../utils/jwks-client.js";
import { AuthStatusSchema } from "./_codecs/auth.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { logger, type HubHono } from "./_shared.js";

export function registerAuthRoutes(app: HubHono): void {
  const authStatusRoute = createRoute({
    method: "get",
    path: "/auth/status",
    tags: ["Auth"],
    summary: "Introspect the calling bearer credential",
    description:
      "Returns metadata about the API key that authenticated this request — " +
      "id, owning user, scopes, expiry, last-used-at. Used by Eve CLI and " +
      "external operators to verify their credential without making " +
      "privileged calls. Returns 401 if no valid bearer was supplied.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Bearer credential introspection.",
        content: { "application/json": { schema: AuthStatusSchema } },
      },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: {
        description:
          "Forbidden — bearer is not an API key (e.g. session-token caller)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description:
          "Key was accepted by the auth middleware but its row was deleted concurrently.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(authStatusRoute, async (c) => {
    const apiKeyId = c.get("apiKeyId");
    const userId = c.get("userId");

    // The middleware sets `apiKeyId` only on the bearer-auth path. Session-
    // token callers (X-Session-Token) reach this handler with a userId but
    // no apiKeyId — there's nothing to introspect. Return 403 so clients
    // can tell the difference between "not authenticated" and "authenticated
    // but with the wrong credential type for this endpoint".
    if (!apiKeyId) {
      return c.json(
        {
          error:
            "/auth/status requires a Bearer API key. Session-token callers have no introspectable key.",
        },
        403
      );
    }
    if (!userId) {
      // Defensive — middleware is supposed to set userId alongside apiKeyId.
      return c.json(
        { error: "Internal error: missing userId on context" },
        500
      );
    }

    try {
      const [row] = await db
        .select({
          keyId: apiKeys.id,
          userId: apiKeys.userId,
          name: apiKeys.keyName,
          scope: apiKeys.scope,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          parentKeyId: apiKeys.parentKeyId,
          isActive: apiKeys.isActive,
          userEmail: users.email,
          userName: users.name,
        })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.userId))
        .where(eq(apiKeys.id, apiKeyId));

      if (!row) {
        // The key passed validation moments ago but the row vanished — most
        // likely a concurrent revoke + cascade delete. Tell the caller in
        // structured form rather than a confusing 500.
        return c.json(
          { error: "API key row not found (revoked concurrently?)" },
          404
        );
      }

      // Drizzle returns Date objects for timestamp columns; the wire schema
      // declares ISO strings. Convert here so the response shape matches.
      return c.json(
        {
          keyId: row.keyId,
          keyIdPrefix: shortenKeyId(row.keyId) ?? "",
          userId: row.userId,
          userEmail: row.userEmail ?? null,
          userName: row.userName ?? null,
          name: row.name ?? null,
          scopes: (row.scope ?? []) as string[],
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
          parentKeyId: row.parentKeyId ?? null,
          isActive: row.isActive,
        },
        200
      );
    } catch (err) {
      logger.error({ err, apiKeyId }, "/auth/status lookup failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/exchange — RFC 7523 JWT-Bearer Grant
// ─────────────────────────────────────────────────────────────────────────────
//
// A trusted issuer (registered in `trusted_issuers` with `auth:exchange-user`
// in its allowed_scopes) signs a short-lived JWT vouching for a user it owns.
// We verify the JWT against the issuer's JWKS, look up the user by email,
// mint a Kratos session via the admin API, and return the session token in
// an OAuth-style response.
//
// Auth: NOT API-key gated. The JWT signature + the trusted_issuers registry
// is the auth primitive. Mounted in `skipAuthPaths` upstream.
//
// Returns OAuth 2.0 error envelopes per RFC 6749 §5.2 so standard OAuth
// clients can react sensibly without parsing prose.
//
// TODO(replay-prevention): the `verifyCpJwt` helper already enforces a 15-min
// jti replay cache in-process. For multi-instance pods we should back this
// with a `used_assertion_nonces` table so a replay against a different node
// is also rejected. Skipped for Phase 3 — single-node pods are fine.

const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const REQUIRED_ISSUER_SCOPE = "auth:exchange-user";
const MAX_ASSERTION_LIFETIME_SECONDS = 300; // 5 minutes
const SESSION_LIFETIME_SECONDS = 86400; // 24h — Kratos default; informational only

type ExchangeAssertion = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
  jti?: unknown;
};

interface KratosSessionResponse {
  session?: { id: string; active?: boolean };
  session_token?: string;
}

export function registerExchangeRoutes(app: HubHono): void {
  app.post("/auth/exchange", async (c) => {
    // RFC 6749 §5.2 error envelope. Inlined as a closure so it captures the
    // typed Hono context — extracting it as a top-level helper trips the
    // typed-Context inference (it resolves to `never` outside the handler).
    const oauthError = (
      status: 400 | 401 | 403 | 404 | 500,
      error: string,
      description?: string
    ) => {
      const body: { error: string; error_description?: string } = { error };
      if (description) body.error_description = description;
      return c.json(body, status);
    };

    // ── Parse body ────────────────────────────────────────────────────────
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return oauthError(400, "invalid_request", "Body must be JSON");
    }

    const grantType: unknown = (body as Record<string, unknown>).grant_type;
    const assertion: unknown = (body as Record<string, unknown>).assertion;

    if (grantType !== GRANT_TYPE_JWT_BEARER) {
      return oauthError(
        400,
        "unsupported_grant_type",
        `grant_type must be ${GRANT_TYPE_JWT_BEARER}`
      );
    }
    if (typeof assertion !== "string" || !assertion) {
      return oauthError(400, "invalid_request", "assertion (JWT) is required");
    }

    // ── Decode (without verifying) to read the iss claim ──────────────────
    let decoded: ExchangeAssertion | null = null;
    try {
      const raw = jwt.decode(assertion);
      if (raw && typeof raw === "object") {
        decoded = raw as ExchangeAssertion;
      }
    } catch {
      // jwt.decode shouldn't throw for malformed tokens (returns null) but
      // belt-and-suspenders.
    }
    if (!decoded) {
      return oauthError(
        400,
        "invalid_grant",
        "assertion is not a decodable JWT"
      );
    }

    const iss = typeof decoded.iss === "string" ? decoded.iss : null;
    const subEmail =
      typeof decoded.sub === "string" ? decoded.sub.trim().toLowerCase() : null;
    const iat = typeof decoded.iat === "number" ? decoded.iat : null;
    const exp = typeof decoded.exp === "number" ? decoded.exp : null;

    if (!iss || !iss.startsWith("https://")) {
      return oauthError(400, "invalid_grant", "iss claim must be an HTTPS URL");
    }
    if (!subEmail) {
      return oauthError(
        400,
        "invalid_grant",
        "sub claim is required (user email)"
      );
    }
    if (iat === null || exp === null) {
      return oauthError(
        400,
        "invalid_grant",
        "iat and exp claims are required"
      );
    }
    // Cap acceptable token lifetime. Clients that mint hour-long assertions
    // are misusing the grant — the assertion is meant to be short-lived.
    if (exp - iat > MAX_ASSERTION_LIFETIME_SECONDS) {
      return oauthError(
        400,
        "invalid_grant",
        `assertion lifetime (exp - iat) must be <= ${MAX_ASSERTION_LIFETIME_SECONDS}s`
      );
    }

    // ── Look up issuer in the trusted_issuers registry ────────────────────
    let issuerEntry;
    try {
      const svc = new TrustedIssuerService();
      issuerEntry = await svc.getByUrl(iss);
    } catch (err) {
      logger.error(
        { err, issuerUrl: iss },
        "/auth/exchange: trusted issuer lookup failed"
      );
      return oauthError(500, "server_error");
    }

    if (!issuerEntry) {
      logger.warn(
        { issuerUrl: iss },
        "/auth/exchange: rejected — issuer not registered"
      );
      return oauthError(401, "invalid_client");
    }
    if (issuerEntry.status !== "approved") {
      logger.warn(
        { issuerUrl: iss, status: issuerEntry.status },
        "/auth/exchange: rejected — issuer not approved"
      );
      return oauthError(401, "invalid_client");
    }
    if (!issuerEntry.allowedScopes.includes(REQUIRED_ISSUER_SCOPE)) {
      logger.warn(
        {
          issuerUrl: iss,
          allowedScopes: issuerEntry.allowedScopes,
          required: REQUIRED_ISSUER_SCOPE,
        },
        "/auth/exchange: rejected — issuer missing required scope"
      );
      return oauthError(403, "insufficient_scope");
    }

    // ── Verify signature + aud + exp + iss + jti via JWKS ─────────────────
    // We pin the issuer to `iss` (the value we just verified is in the
    // registry). verifyCpJwt enforces signature, expiry, audience match,
    // issuer claim equality, and tracks jti to block replay (15 min window).
    const podPublicUrl = process.env.PUBLIC_URL;
    if (!podPublicUrl) {
      logger.error(
        "/auth/exchange: PUBLIC_URL not configured — audience check is mandatory"
      );
      return oauthError(500, "server_error");
    }

    const verified = await verifyCpJwt<ExchangeAssertion>(
      assertion,
      iss,
      podPublicUrl
    );
    if (!verified) {
      logger.warn(
        { issuerUrl: iss, sub: subEmail },
        "/auth/exchange: JWT verification failed (signature/aud/exp/jti)"
      );
      return oauthError(
        400,
        "invalid_grant",
        "assertion signature, audience, expiry, or jti check failed"
      );
    }

    // ── Look up the user by email ─────────────────────────────────────────
    const user = await db.query.users.findFirst({
      where: eq(users.email, subEmail),
      columns: {
        id: true,
        email: true,
        name: true,
        userType: true,
        kratosIdentityId: true,
      },
    });

    if (!user) {
      logger.warn(
        { issuerUrl: iss, sub: subEmail },
        "/auth/exchange: user_not_found"
      );
      return oauthError(404, "user_not_found");
    }
    // Agents don't have Kratos identities — refuse to mint a session for them.
    if (user.userType !== "human" || !user.kratosIdentityId) {
      logger.warn(
        {
          issuerUrl: iss,
          sub: subEmail,
          userType: user.userType,
          hasKratosId: !!user.kratosIdentityId,
        },
        "/auth/exchange: refused — user is not a human with a Kratos identity"
      );
      return oauthError(404, "user_not_found");
    }

    // ── Mint a Kratos session via the admin API ───────────────────────────
    // Same primitive used by /api/handshake (apps/api/src/index.ts ~620):
    // POST /admin/identities/:id/sessions returns a session_token that the
    // browser/CLI can use as the ory_kratos_session cookie or X-Session-Token.
    const kratosAdminUrl =
      process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

    let kratosResp: Response;
    try {
      kratosResp = await fetch(
        `${kratosAdminUrl}/admin/identities/${user.kratosIdentityId}/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(8_000),
        }
      );
    } catch (err) {
      logger.error(
        { err, issuerUrl: iss, sub: subEmail },
        "/auth/exchange: Kratos admin API unreachable"
      );
      return oauthError(500, "server_error");
    }

    if (!kratosResp.ok) {
      const errBody = await kratosResp.text().catch(() => "");
      logger.error(
        {
          status: kratosResp.status,
          body: errBody.slice(0, 300),
          issuerUrl: iss,
          sub: subEmail,
        },
        "/auth/exchange: Kratos session creation failed"
      );
      return oauthError(500, "server_error");
    }

    const sessionData = (await kratosResp
      .json()
      .catch(() => null)) as KratosSessionResponse | null;
    const accessToken = sessionData?.session_token;
    if (!accessToken) {
      logger.error(
        { issuerUrl: iss, sub: subEmail },
        "/auth/exchange: Kratos returned 200 but no session_token (check tokenizer config)"
      );
      return oauthError(500, "server_error");
    }

    logger.info(
      { issuerUrl: iss, sub: subEmail, userId: user.id },
      "/auth/exchange: session minted"
    );

    return c.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: SESSION_LIFETIME_SECONDS,
        scope: "user",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
      200
    );
  });
}
