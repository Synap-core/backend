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

export async function createContext(req: Request): Promise<Context> {
  // Initialize database
  const db = await getDbInstance();

  // Use Ory Kratos session for authentication
  try {
    const authModule = await import("@synap/auth");
    if (!authModule.getSession) {
      throw new InternalServerError("getSession not available", {
        module: "@synap/auth",
      });
    }
    // Debug logging for cookie presence
    const cookieHeader = req.headers.get("cookie");
    contextLogger.info(
      {
        hasCookie: !!cookieHeader,
        cookieLength: cookieHeader?.length || 0,
      },
      "Attempting to get session from request"
    );

    // Try cache first (optional optimization)
    let session: any | null = null;
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

    // Extract workspace ID from header (set by frontend workspaceLink)
    // Try both case variations (HTTP headers are case-insensitive, but some implementations are strict)
    const workspaceId =
      req.headers.get("X-Workspace-Id") ||
      req.headers.get("x-workspace-id") ||
      null;

    // Debug logging for workspace ID extraction
    if (process.env.NODE_ENV === "development" || process.env.DEBUG_WORKSPACE) {
      const allHeaders = Array.from(req.headers.entries());
      const workspaceHeaders = allHeaders.filter(([k]) =>
        k.toLowerCase().includes("workspace")
      );
      contextLogger.debug(
        {
          workspaceId,
          hasWorkspaceHeader: !!workspaceId,
          workspaceHeaders,
          allHeaderKeys: allHeaders.map(([k]) => k),
        },
        "Workspace ID extraction from headers"
      );
    }

    // Kratos session structure: { identity: { id, traits: { email, name } } }
    if (session && session.identity) {
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
