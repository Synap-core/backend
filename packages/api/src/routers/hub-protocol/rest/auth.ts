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
import {
  db,
  apiKeys,
  and,
  users,
  federatedIdentityLinks,
  consumeFederatedAssertionReceipt,
  projectMembers,
  projects,
  projectPodUserAccess,
  workspaceMembers,
  workspaces,
  eq,
  TrustedIssuerService,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";

import { shortenKeyId } from "../../../utils/auth-error.js";
import { normalizeIssuerUrl } from "../../../utils/issuer-url-safety.js";
import { verifyTrustedIssuerJwt } from "../../../utils/jwks-client.js";
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
          keyType: apiKeys.keyType,
          workspaceId: apiKeys.workspaceId,
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
          keyType: row.keyType,
          workspaceId: row.workspaceId ?? null,
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
// in its allowed_scopes) signs a short-lived JWT for one of its opaque
// subjects. We verify the JWT against the issuer's JWKS, resolve the Pod-local
// `(issuer, subject) → user` link, then mint a Kratos session. Email is never
// used as a cross-issuer identity key.
//
// Auth: NOT API-key gated. The JWT signature + the trusted_issuers registry
// is the auth primitive. Mounted in `skipAuthPaths` upstream.
//
// Returns OAuth 2.0 error envelopes per RFC 6749 §5.2 so standard OAuth
// clients can react sensibly without parsing prose.
//
const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const REQUIRED_ISSUER_SCOPE = TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE;
const MAX_ASSERTION_LIFETIME_SECONDS = 300; // 5 minutes
const SESSION_LIFETIME_SECONDS = 86400; // 24h — Kratos default; informational only

type ExchangeAssertion = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
  jti?: unknown;
  type?: unknown;
  purpose?: unknown;
  requestedScope?: unknown;
};

interface KratosSessionResponse {
  session?: { id: string; active?: boolean };
  session_token?: string;
}

type RequestedScope =
  | { kind: "pod" }
  | { kind: "workspace"; id: string }
  | { kind: "project"; id: string };

function parseRequestedScope(value: unknown): RequestedScope | null {
  if (value === undefined) return { kind: "pod" };
  if (!value || typeof value !== "object") return null;
  const scope = value as Record<string, unknown>;
  if (scope.kind === "pod") return { kind: "pod" };
  if (
    (scope.kind === "workspace" || scope.kind === "project") &&
    typeof scope.id === "string" &&
    scope.id.length > 0
  ) {
    return { kind: scope.kind, id: scope.id };
  }
  return null;
}

async function getPodAuthoritativeAccess(userId: string) {
  const [memberships, projectMemberships] = await Promise.all([
    db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        systemSlug: workspaces.systemSlug,
        workspaceArchivedAt: workspaces.archivedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId)),
    db
      .select({
        projectId: projectMembers.projectId,
        workspaceId: projects.workspaceId,
        role: projectMembers.role,
        status: projects.status,
        workspaceArchivedAt: workspaces.archivedAt,
        workspaceSystemSlug: workspaces.systemSlug,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projectMembers.userId, userId)),
  ]);
  return projectPodUserAccess(memberships, projectMemberships);
}

function canUseRequestedScope(
  access: Awaited<ReturnType<typeof getPodAuthoritativeAccess>>,
  scope: RequestedScope
): boolean {
  const hasActiveScope =
    access.workspaceScopes.length > 0 || access.projectScopes.length > 0;
  if (scope.kind === "pod") {
    return (
      hasActiveScope || access.podRole === "owner" || access.podRole === "admin"
    );
  }
  return scope.kind === "workspace"
    ? access.workspaceScopes.some((entry) => entry.workspaceId === scope.id)
    : access.projectScopes.some((entry) => entry.projectId === scope.id);
}

export function registerExchangeRoutes(app: HubHono): void {
  app.post("/auth/exchange", async (c) => {
    // RFC 6749 §5.2 error envelope. Inlined as a closure so it captures the
    // typed Hono context — extracting it as a top-level helper trips the
    // typed-Context inference (it resolves to `never` outside the handler).
    const oauthError = (
      status: 400 | 401 | 403 | 404 | 500 | 503,
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

    const rawIssuer = typeof decoded.iss === "string" ? decoded.iss : null;
    const issuerUrl = rawIssuer ? normalizeIssuerUrl(rawIssuer) : null;
    const issuerSubject =
      typeof decoded.sub === "string" ? decoded.sub.trim() : null;
    const iat = typeof decoded.iat === "number" ? decoded.iat : null;
    const exp = typeof decoded.exp === "number" ? decoded.exp : null;

    if (!issuerUrl || rawIssuer !== issuerUrl) {
      return oauthError(
        400,
        "invalid_grant",
        "iss claim must be a canonical HTTPS issuer URL"
      );
    }
    if (!issuerSubject) {
      return oauthError(
        400,
        "invalid_grant",
        "sub claim is required (issuer subject)"
      );
    }
    if (
      iat === null ||
      exp === null ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(exp) ||
      exp <= iat ||
      iat > Math.floor(Date.now() / 1_000) + 60
    ) {
      return oauthError(400, "invalid_grant", "iat and exp claims are invalid");
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

    // ── Verify trusted issuer + signature + aud + exp + iss + jti ─────────
    // The trusted verifier consults the Pod-local issuer registry before any
    // outbound JWKS request, then pins verification to the approved issuer.
    const podPublicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    if (!podPublicUrl) {
      logger.error(
        "/auth/exchange: PUBLIC_URL not configured — audience check is mandatory"
      );
      return oauthError(500, "server_error");
    }

    const verified = await verifyTrustedIssuerJwt<ExchangeAssertion>(
      assertion,
      {
        audience: podPublicUrl,
        requiredScope: REQUIRED_ISSUER_SCOPE,
      }
    );
    if (!verified) {
      logger.warn(
        { issuerUrl, issuerSubject },
        "/auth/exchange: JWT verification failed (signature/aud/exp/jti)"
      );
      return oauthError(
        400,
        "invalid_grant",
        "assertion signature, audience, expiry, or jti check failed"
      );
    }

    if (
      verified.type !== "federated_assertion" ||
      verified.purpose !== "user-exchange" ||
      typeof verified.sub !== "string" ||
      typeof verified.jti !== "string" ||
      verified.sub.trim() !== issuerSubject
    ) {
      return oauthError(
        400,
        "invalid_grant",
        "assertion must be a federated user-exchange assertion"
      );
    }
    const requestedScope = parseRequestedScope(verified.requestedScope);
    if (!requestedScope) {
      return oauthError(400, "invalid_grant", "requestedScope is invalid");
    }

    // Re-read after verification so revocation between the verifier lookup and
    // the Pod-local link resolution fails closed.
    const issuerEntry = await new TrustedIssuerService().getByUrl(issuerUrl);
    if (
      !issuerEntry ||
      issuerEntry.status !== "approved" ||
      !issuerEntry.allowedScopes.includes(REQUIRED_ISSUER_SCOPE)
    ) {
      return oauthError(401, "invalid_client");
    }

    // The shared verifier has a short in-process JTI cache. Persist the
    // issuer-qualified receipt before resolving a user or minting a session so
    // replay protection survives restarts and multiple Pod API processes.
    try {
      const receipt = await consumeFederatedAssertionReceipt({
        issuerId: issuerEntry.id,
        jti: verified.jti,
        expiresAt: new Date(exp * 1_000),
      });
      if (receipt === "expired") {
        return oauthError(400, "invalid_grant", "assertion has expired");
      }
      if (receipt === "replayed") {
        return oauthError(400, "invalid_grant", "assertion was already used");
      }
    } catch (error) {
      logger.error(
        { error, issuerId: issuerEntry.id },
        "/auth/exchange: durable assertion receipt unavailable"
      );
      return oauthError(
        503,
        "temporarily_unavailable",
        "assertion replay protection is unavailable"
      );
    }

    // ── Resolve the user by issuer-qualified identity link ────────────────
    const identityLink = await db.query.federatedIdentityLinks.findFirst({
      where: and(
        eq(federatedIdentityLinks.issuerId, issuerEntry.id),
        eq(federatedIdentityLinks.issuerSubject, issuerSubject)
      ),
      columns: { userId: true },
    });
    if (!identityLink) {
      logger.warn(
        { issuerUrl, issuerSubject },
        "/auth/exchange: issuer subject is not linked on this Pod"
      );
      return oauthError(404, "user_not_found");
    }
    const user = await db.query.users.findFirst({
      where: eq(users.id, identityLink.userId),
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
        { issuerUrl, issuerSubject },
        "/auth/exchange: user_not_found"
      );
      return oauthError(404, "user_not_found");
    }
    // Agents don't have Kratos identities — refuse to mint a session for them.
    if (user.userType !== "human" || !user.kratosIdentityId) {
      logger.warn(
        {
          issuerUrl,
          issuerSubject,
          userType: user.userType,
          hasKratosId: !!user.kratosIdentityId,
        },
        "/auth/exchange: refused — user is not a human with a Kratos identity"
      );
      return oauthError(404, "user_not_found");
    }

    const access = await getPodAuthoritativeAccess(user.id);
    if (!canUseRequestedScope(access, requestedScope)) {
      logger.warn(
        { issuerUrl, issuerSubject, requestedScope },
        "/auth/exchange: linked user has no active Pod access"
      );
      return oauthError(403, "insufficient_scope");
    }

    // ── Mint a Kratos session via the admin API ───────────────────────────
    // Same primitive used by the generic federation exchange route:
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
        { err, issuerUrl, issuerSubject },
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
          issuerUrl,
          issuerSubject,
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
        { issuerUrl, issuerSubject },
        "/auth/exchange: Kratos returned 200 but no session_token (check tokenizer config)"
      );
      return oauthError(500, "server_error");
    }

    logger.info(
      { issuerUrl, issuerSubject, userId: user.id },
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
