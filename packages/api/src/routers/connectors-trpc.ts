/**
 * Connectors tRPC Router
 *
 * Proxies connector operations to the Control Plane.
 * The browser calls these tRPC procedures, which forward to CP REST endpoints.
 *
 * Procedures:
 *   connectors.providers   — List available providers with connection status
 *   connectors.connections — List user's active connections
 *   connectors.session     — Get Nango Connect session token for OAuth UI
 *   connectors.disconnect  — Revoke a connection
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { config, createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { db, eq, entityExternalLinks } from "@synap/database";

const logger = createLogger({ module: "connectors-trpc" });

/** Extract session token from request cookie header. */
function getSessionToken(req: Request | undefined): string | undefined {
  const cookie = req?.headers.get("cookie") ?? "";
  const match = cookie.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? undefined;
}

/**
 * Build the CP API URL for a given path.
 * Pod communicates with CP via its stored controlPlaneUrl.
 */
function getCpUrl(path: string): string | null {
  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) return null;
  return `${cpUrl}/api/connectors${path}`;
}

/**
 * Forward a request to the CP connectors API.
 * Uses the user's session for authentication.
 */
async function cpFetch(
  path: string,
  options: {
    method: string;
    body?: unknown;
    sessionToken?: string;
    query?: Record<string, string>;
  }
): Promise<unknown> {
  const baseUrl = getCpUrl(path);
  if (!baseUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Control Plane not configured",
    });
  }

  const url = new URL(baseUrl);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.sessionToken) {
    headers["Authorization"] = `Bearer ${options.sessionToken}`;
    headers["Cookie"] = `better-auth.session_token=${options.sessionToken}`;
  }

  const response = await fetch(url.toString(), {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    logger.warn(
      { status: response.status, path, body: errBody },
      "CP connector request failed"
    );
    throw new TRPCError({
      code: response.status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
      message: `Connector operation failed: ${errBody}`,
    });
  }

  return response.json();
}

export const connectorsRouter = router({
  /**
   * List available providers with their connection status for this pod.
   */
  providers: protectedProcedure.query(async ({ ctx }) => {
    // Get the pod ID from workspace settings (stored during CP provisioning)
    const podId = getPodId();

    const result = (await cpFetch("/providers", {
      method: "GET",
      sessionToken: getSessionToken(ctx.req),
      query: podId ? { podId } : undefined,
    })) as { providers: unknown[] };

    return result.providers;
  }),

  /**
   * List user's active connections for this pod.
   */
  connections: protectedProcedure.query(async ({ ctx }) => {
    const podId = getPodId();

    const result = (await cpFetch("/connections", {
      method: "GET",
      sessionToken: getSessionToken(ctx.req),
      query: podId ? { podId } : undefined,
    })) as { connections: unknown[] };

    return result.connections;
  }),

  /**
   * Get a Nango Connect session token for the OAuth UI.
   */
  session: protectedProcedure.mutation(async ({ ctx }) => {
    const podId = getPodId();
    if (!podId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Pod ID not configured",
      });
    }

    const result = (await cpFetch("/session", {
      method: "POST",
      sessionToken: getSessionToken(ctx.req),
      body: { podId },
    })) as { token: string };

    return { token: result.token };
  }),

  /**
   * Disconnect a connector.
   */
  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await cpFetch("/disconnect", {
        method: "POST",
        sessionToken: getSessionToken(ctx.req),
        body: { connectionId: input.connectionId },
      });

      return { success: true };
    }),

  /**
   * Get external source links for an entity.
   * Returns the connector providers that synced this entity.
   */
  entitySources: protectedProcedure
    .input(z.object({ entityId: z.string().uuid() }))
    .query(async ({ input }) => {
      const links = await db
        .select({
          provider: entityExternalLinks.provider,
          status: entityExternalLinks.status,
          lastSyncedAt: entityExternalLinks.lastSyncedAt,
        })
        .from(entityExternalLinks)
        .where(eq(entityExternalLinks.entityId, input.entityId));

      return links;
    }),
});

/**
 * Get the pod ID from environment / workspace settings.
 * This is set during CP provisioning.
 */
function getPodId(): string | null {
  return process.env.POD_ID || null;
}
