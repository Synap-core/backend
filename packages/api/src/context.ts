/**
 * tRPC Context
 *
 * PostgreSQL-only with Ory Kratos session authentication for multi-user support.
 */

import { getDb } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { InternalServerError } from "@synap-core/types";
import type { Context, KratosSession, User } from "./types/context.js";
import { sessionCache } from "./utils/sessionCache.js";
import { resolveHubSessionHeader } from "./routers/hub-protocol/_middleware/session.js";

// Re-export types
export type { Context, KratosSession, User };

const contextLogger = createLogger({ module: "api-context" });

// Initialize database connection once at module load
let dbInstance: Awaited<ReturnType<typeof getDb>> | null = null;
async function getDbInstance() {
  if (!dbInstance) {
    dbInstance = await getDb();
  }
  return dbInstance;
}

/**
 * Create tRPC context from Request
 *
 * If honoCtx is provided (from Hono middleware), uses pre-validated session
 * to avoid duplication. Otherwise, validates session with Kratos.
 *
 * @param req - Request object (standard or from Hono)
 * @param honoCtx - Optional Hono context with pre-validated session (from orySessionMiddleware)
 */
export async function createContext(
  req: Request,
  honoCtx?: { get: (key: string) => unknown }
): Promise<Context> {
  // Initialize database
  const db = await getDbInstance();

  // Use Ory Kratos session for authentication
  try {
    // If Hono context is provided, use pre-validated session (no duplication)
    // This is the case when called from apps/api/src/index.ts with orySessionMiddleware
    let session: KratosSession | null = null;

    if (honoCtx) {
      // Use pre-validated session from Hono middleware (already validated by orySessionMiddleware)
      session = (honoCtx.get("session") as KratosSession | undefined) || null;
      contextLogger.debug(
        { fromHonoContext: true },
        "Using pre-validated session from Hono context"
      );
    } else {
      // No Hono context: validate session ourselves (for non-Hono usage)
      const authModule = await import("@synap/auth");
      if (!authModule.getSession) {
        throw new InternalServerError("getSession not available", {
          module: "@synap/auth",
        });
      }

      const cookieHeader = req.headers.get("cookie");

      // Try cache first (optional optimization)
      const cachedSession = sessionCache.get(cookieHeader || "");
      if (cachedSession !== undefined) {
        session = cachedSession;
        contextLogger.debug({ cached: true }, "Using cached session");
      } else {
        // Validate with Kratos
        session = await authModule.getSession(req.headers);
        // Cache result (only valid sessions are cached)
        sessionCache.set(cookieHeader || "", session, 5000);
      }
    }

    // Extract workspace ID from header (set by frontend workspaceLink)
    // Try both case variations (HTTP headers are case-insensitive, but some implementations are strict)
    const workspaceId =
      req.headers.get("X-Workspace-Id") ||
      req.headers.get("x-workspace-id") ||
      null;

    // Extract the PROJECT lens from its header (orthogonal to the workspace
    // lens; an optional cross-cutting narrowing). Same case-insensitive read.
    const projectId =
      req.headers.get("X-Project-Id") ||
      req.headers.get("x-project-id") ||
      null;

    // Kratos session structure: { identity: { id, traits: { email, name } } }
    if (session && session.identity) {
      // Focus-session handle. Same header, same verification as the Hub door:
      // `resolveHubSessionHeader` rejects a non-uuid AND a session that is not
      // the caller's own. Only reached for an authenticated request — an
      // unauthenticated one has no principal to verify against.
      //
      // SCOPE OF THE GUARANTEE, stated precisely because an earlier version of
      // this comment overstated it: what is verified is the value ARRIVING BY
      // HEADER. Several routers also accept a `sessionId` in the request BODY
      // (`capture.execute` among them), which nothing validates. Those sites must
      // prefer this ctx value over the body one — `capture.ts` now does. This
      // header path guarantees `ctx.sessionId` is the caller's own; it cannot
      // guarantee anything about a session id a router reads from elsewhere.
      const sessionId = await resolveHubSessionHeader(
        req.headers.get("X-Session-Id") ??
          req.headers.get("x-session-id") ??
          undefined,
        session.identity.id
      );

      return {
        db,
        authenticated: true,
        userId: session.identity.id,
        user: {
          id: session.identity.id,
          email: session.identity.traits.email,
          name: session.identity.traits.name,
        },
        session,
        req,
        workspaceId, // Add workspace ID to context
        projectId, // Add project lens to context
        sessionId, // Verified focus-session handle (undefined when absent/invalid)
      };
    }

    // No valid session
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
      req,
      workspaceId, // Add workspace ID even for unauthenticated (for public routes)
      projectId,
    };
  } catch (error) {
    contextLogger.error(
      {
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        cookiePresent: !!req.headers.get("cookie"),
        cookieLength: req.headers.get("cookie")?.length || 0,
      },
      "Error getting session (detailed debug)"
    );
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
      req,
      workspaceId: null, // No workspace ID on error
    };
  }
}
