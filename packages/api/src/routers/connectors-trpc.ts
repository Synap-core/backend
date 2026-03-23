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
 * Resolve the CP URL. Follows the established pod pattern:
 *   1. Env var CONTROL_PLANE_URL (fast, no DB hit)
 *   2. workspace.settings.controlPlane.url (set during provisioning)
 */
let cpUrlCache: { url: string | null; resolvedAt: number } | null = null;
const CP_URL_CACHE_TTL = 5 * 60_000; // 5 min

async function resolveCpUrl(): Promise<string | null> {
  // 1. Env var — fast path
  if (config.server.controlPlaneUrl) return config.server.controlPlaneUrl;

  // 2. Cache hit
  if (cpUrlCache && Date.now() - cpUrlCache.resolvedAt < CP_URL_CACHE_TTL) {
    return cpUrlCache.url;
  }

  // 3. Read from workspace settings (set during CP provisioning)
  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    const url = cp?.url ?? null;
    cpUrlCache = { url, resolvedAt: Date.now() };
    return url;
  } catch {
    return null;
  }
}

/**
 * Build the CP API URL for a given path.
 */
function buildCpUrl(cpUrl: string, path: string): string {
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
  const cpUrl = await resolveCpUrl();
  if (!cpUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Control Plane not configured — pod has not been provisioned or CONTROL_PLANE_URL is not set",
    });
  }

  const url = new URL(buildCpUrl(cpUrl, path));
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
    const podId = await getPodId();

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
    const podId = await getPodId();

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
    const podId = await getPodId();
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
 * Follows same pattern as CP URL: env var first, then DB fallback.
 */
let podIdCache: { id: string | null; resolvedAt: number } | null = null;

async function getPodId(): Promise<string | null> {
  if (process.env.POD_ID) return process.env.POD_ID;

  if (podIdCache && Date.now() - podIdCache.resolvedAt < CP_URL_CACHE_TTL) {
    return podIdCache.id;
  }

  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { podId?: string } | undefined;
    const id = cp?.podId ?? null;
    podIdCache = { id, resolvedAt: Date.now() };
    return id;
  } catch {
    return null;
  }
}
