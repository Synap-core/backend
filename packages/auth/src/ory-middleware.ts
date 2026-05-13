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

  if (!cookie && !sessionToken) {
    return c.json(
      { error: "Unauthorized", details: "No session cookie or token" },
      401
    );
  }

  // MOCK AUTH BYPASS (Development/Test Only)
  if (
    process.env.NODE_ENV !== "production" &&
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

  // Get session from Kratos — try X-Session-Token first (API clients),
  // then fall back to cookie-based auth (browser).
  // getKratosSession/ByToken returns null for 401/403 (invalid session),
  // and throws for network errors or Kratos unavailability.
  let session: unknown;
  try {
    session = sessionToken
      ? await getKratosSessionByToken(sessionToken)
      : await getKratosSession(cookie);
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
