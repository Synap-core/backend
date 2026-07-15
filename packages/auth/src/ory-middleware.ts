/**
 * Ory Auth Middleware for Hono
 *
 * Validates OAuth2 tokens from Hydra and extracts user identity from Kratos
 */

import type { MiddlewareHandler } from "hono";
import { introspectToken } from "./ory-hydra.js";
import {
  getIdentityById,
  getKratosSession,
  getKratosSessionByToken,
} from "./ory-kratos.js";
import {
  buildLocalUser,
  buildLocalSession,
  isLocalModeEnabled,
  getLocalAuthToken,
  safeTokenEqual,
} from "./local-mode.js";

/**
 * Middleware for OAuth2 token authentication (Bearer tokens)
 *
 * Used for API requests with OAuth2 tokens (from Hydra)
 */
export const oryAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.substring(7);

  // Introspect token with Hydra
  const tokenInfo = await introspectToken(token);

  if (!tokenInfo || !tokenInfo.active) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Get identity from Kratos
  const identity = await getIdentityById(tokenInfo.sub);

  if (!identity) {
    return c.json({ error: "Identity not found" }, 401);
  }

  // Add to context
  c.set("user", {
    id: identity.id,
    email: identity.traits.email,
    name: identity.traits.name,
  });
  c.set("userId", identity.id);
  c.set("scopes", tokenInfo.scope?.split(" ") || []);
  c.set("authenticated", true);

  return next();
};

/**
 * Middleware for session-based authentication (Kratos sessions)
 *
 * Used for browser-based requests with session cookies
 */
export const orySessionMiddleware: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header("cookie") || "";
  const sessionToken = c.req.header("x-session-token") || "";
  // API server middleware can mark an owner-approved external browser origin
  // as strict. That origin may never fall back to an ambient Pod cookie: it
  // must authenticate with its explicit X-Session-Token on every request.
  const requireExplicitSessionToken =
    c.get("requireExplicitSessionToken" as never) === true;

  // ── LOCAL MODE: fixed-identity auth, no Kratos ──────────────────────────
  // Authenticate via a static bearer token or x-local-token header.
  // The Electron host generates LOCAL_AUTH_TOKEN and passes it on every
  // request. Any other token (or a missing token) → 401.
  // ory_kratos_session cookie is NOT accepted here — LOCAL_MODE uses only
  // bearer or x-local-token channels.
  if (isLocalModeEnabled()) {
    const localAuthToken = getLocalAuthToken();
    const authHeader = c.req.header("Authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    const incomingToken =
      bearerToken || c.req.header("x-local-token") || sessionToken;

    if (
      !incomingToken ||
      !localAuthToken ||
      !safeTokenEqual(incomingToken, localAuthToken)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const localUser = buildLocalUser();
    const localSession = buildLocalSession();
    c.set("user", { ...localUser });
    c.set("userId", localUser.id);
    c.set("session", { ...localSession });
    c.set("authenticated", true);
    return next();
  }
  // ────────────────────────────────────────────────────────────────────────

  if (!cookie && !sessionToken) {
    return c.json(
      { error: "Unauthorized", details: "No session cookie or token" },
      401
    );
  }

  // MOCK AUTH BYPASS (Test Only — not active in staging or production)
  if (
    process.env.NODE_ENV === "test" &&
    cookie.includes("mock-session-cookie=")
  ) {
    const match = cookie.match(/mock-session-cookie=([^;]+)/);
    const mockUserId = match ? match[1] : "mock-user";
    // Setup mock context
    c.set("user", {
      id: mockUserId,
      email: `mock-${mockUserId}@example.com`,
      name: "Mock User",
    });
    c.set("userId", mockUserId);
    c.set("session", {
      id: "mock-session-" + mockUserId,
      identity: {
        id: mockUserId,
        traits: {
          email: `mock-${mockUserId}@example.com`,
          name: "Mock User",
        },
      },
    });
    c.set("authenticated", true);
    return next();
  }

  // Get session from Kratos.
  // Priority: X-Session-Token header → cookie (browser flow) → cookie value
  // as raw session token (API flow tokens stored in ory_kratos_session cookie).
  //
  // The third path handles Eve's login flow: kratos-auth/route.ts stores the
  // raw API `session_token` as the ory_kratos_session cookie value. Kratos
  // rejects that raw token when forwarded as a cookie (it expects an encrypted
  // browser-flow cookie), but accepts it as X-Session-Token.
  let session: unknown;
  try {
    // X-Session-Token first (API clients). CRITICAL: a STALE/invalid token must NOT
    // shadow a valid cookie. The Electron browser ALWAYS sends X-Session-Token, so
    // if it has expired while the Kratos cookie is still good, a token-only check
    // returns null → 401 on a perfectly valid session — the "proven via cookie but
    // every /trpc 401s forever" divergence + signout loop. So a null token result
    // falls THROUGH to cookie auth (this is the real /trpc hot path — getSession()
    // is the non-Hono path; both must agree).
    if (sessionToken) {
      session = await getKratosSessionByToken(sessionToken);
    }
    if (!session && requireExplicitSessionToken) {
      return c.json({ error: "Invalid X-Session-Token" }, 401);
    }
    if (!session) {
      // Encrypted browser cookie first
      session = await getKratosSession(cookie);

      // Then the raw ory_kratos_session value as a session token (API-flow tokens
      // stored as cookies — e.g. Eve's login flow).
      if (!session) {
        const match = cookie.match(/(?:^|;\s*)ory_kratos_session=([^;]+)/);
        if (match?.[1]) {
          session = await getKratosSessionByToken(match[1]).catch(() => null);
        }
      }
    }
  } catch {
    return c.json(
      {
        error: "auth_service_unavailable",
        message: "Kratos is temporarily unreachable. Please retry.",
      },
      503
    );
  }

  const validSession = session as {
    identity?: { id: string; traits: { email: string; name: string } };
  } | null;
  if (!validSession?.identity) {
    return c.json({ error: "Invalid session" }, 401);
  }

  // Add to context
  c.set("user", {
    id: validSession.identity.id,
    email: validSession.identity.traits.email,
    name: validSession.identity.traits.name,
  });
  c.set("userId", validSession.identity.id);
  c.set("session", validSession);
  c.set("authenticated", true);

  return next();
};
