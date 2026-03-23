/**
 * Connectors tRPC Router
 *
 * Proxies connector operations to a Control Plane.
 * The frontend sends the CP URL with each request; the pod validates it
 * against its provisioned allowlist before proxying.
 *
 * Security: The pod only proxies to URLs that were established via a
 * cryptographically verified provisioning flow (ES256 JWT). This prevents
 * SSRF — the pod never fetches from arbitrary user-supplied URLs.
 *
 * Procedures:
 *   connectors.providers   — List available providers with connection status
 *   connectors.connections — List user's active connections
 *   connectors.session     — Get Nango Connect session token for OAuth UI
 *   connectors.disconnect  — Revoke a connection
 *   connectors.entitySources — Get external links for an entity (local DB)
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { config, createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { db, eq, entityExternalLinks } from "@synap/database";

const logger = createLogger({ module: "connectors-trpc" });

// ─── CP URL validation (SSRF prevention) ─────────────────────────────────────

const CACHE_TTL = 5 * 60_000; // 5 min

interface CacheEntry<T> {
  value: T;
  resolvedAt: number;
}

let allowedCpUrlsCache: CacheEntry<string[]> | null = null;
let podIdCache: CacheEntry<string | null> | null = null;

/**
 * Load the set of trusted CP URLs from provisioning data.
 * These were set via cryptographically signed JWTs during provisioning.
 */
async function getAllowedCpUrls(): Promise<string[]> {
  if (
    allowedCpUrlsCache &&
    Date.now() - allowedCpUrlsCache.resolvedAt < CACHE_TTL
  ) {
    return allowedCpUrlsCache.value;
  }

  const urls: string[] = [];

  // 1. Env var
  if (config.server.controlPlaneUrl) {
    urls.push(normalize(config.server.controlPlaneUrl));
  }

  // 2. DB — workspace.settings.controlPlane.url (set via signed provision JWT)
  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string; allowedUrls?: string[] } | undefined;
    if (cp?.url) urls.push(normalize(cp.url));
    // Future: additional allowed URLs for third-party CPs
    if (Array.isArray(cp?.allowedUrls)) {
      for (const u of cp.allowedUrls) {
        if (typeof u === "string") urls.push(normalize(u));
      }
    }
  } catch {
    // DB unavailable — only env var URLs are allowed
  }

  const deduped = [...new Set(urls)];
  allowedCpUrlsCache = { value: deduped, resolvedAt: Date.now() };
  return deduped;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/**
 * Validate a frontend-provided CP URL against the provisioned allowlist.
 * Throws FORBIDDEN if the URL is not trusted.
 */
async function validateCpUrl(requestedUrl: string): Promise<string> {
  const normalized = normalize(requestedUrl);
  const allowed = await getAllowedCpUrls();

  if (allowed.includes(normalized)) {
    // Return the original (non-lowercased) URL for actual HTTP calls
    return requestedUrl.replace(/\/+$/, "");
  }

  logger.warn({ requestedUrl, allowed }, "Rejected untrusted CP URL");
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "Control Plane URL not recognized. The pod only proxies to its provisioned CP.",
  });
}

/**
 * Resolve CP URL: use frontend-provided URL (validated) or fall back to
 * the first provisioned URL.
 */
async function resolveCpUrl(
  frontendUrl: string | undefined
): Promise<string | null> {
  if (frontendUrl) return validateCpUrl(frontendUrl);

  // Fallback: first allowed URL (env var > DB)
  const allowed = await getAllowedCpUrls();
  return allowed[0] ?? null;
}

// ─── Pod ID resolution ────────────────────────────────────────────────────────

async function getPodId(): Promise<string | null> {
  if (process.env.POD_ID) return process.env.POD_ID;

  if (podIdCache && Date.now() - podIdCache.resolvedAt < CACHE_TTL) {
    return podIdCache.value;
  }

  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { podId?: string } | undefined;
    const id = cp?.podId ?? null;
    podIdCache = { value: id, resolvedAt: Date.now() };
    return id;
  } catch {
    return null;
  }
}

// ─── CP fetch helper ──────────────────────────────────────────────────────────

/** Extract session token from request cookie header. */
function getSessionToken(req: Request | undefined): string | undefined {
  const cookie = req?.headers.get("cookie") ?? "";
  const match = cookie.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ?? undefined;
}

/**
 * Forward a request to the CP connectors API.
 */
async function cpFetch(
  cpUrl: string,
  path: string,
  options: {
    method: string;
    body?: unknown;
    sessionToken?: string;
    query?: Record<string, string>;
  }
): Promise<unknown> {
  const url = new URL(`${cpUrl}/api/connectors${path}`);
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

// ─── Shared input schema ──────────────────────────────────────────────────────

/** All CP-proxying procedures accept an optional cpUrl from the frontend. */
const cpUrlInput = z.object({ cpUrl: z.string().url().optional() }).optional();

// ─── Router ───────────────────────────────────────────────────────────────────

export const connectorsRouter = router({
  /**
   * List available providers with their connection status for this pod.
   */
  providers: protectedProcedure
    .input(cpUrlInput)
    .query(async ({ ctx, input }) => {
      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const podId = await getPodId();

      const result = (await cpFetch(cpUrl, "/providers", {
        method: "GET",
        sessionToken: getSessionToken(ctx.req),
        query: podId ? { podId } : undefined,
      })) as { providers: unknown[] };

      return result.providers;
    }),

  /**
   * List user's active connections for this pod.
   */
  connections: protectedProcedure
    .input(cpUrlInput)
    .query(async ({ ctx, input }) => {
      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const podId = await getPodId();

      const result = (await cpFetch(cpUrl, "/connections", {
        method: "GET",
        sessionToken: getSessionToken(ctx.req),
        query: podId ? { podId } : undefined,
      })) as { connections: unknown[] };

      return result.connections;
    }),

  /**
   * Get a Nango Connect session token for the OAuth UI.
   */
  session: protectedProcedure
    .input(cpUrlInput)
    .mutation(async ({ ctx, input }) => {
      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const podId = await getPodId();
      if (!podId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Pod ID not configured",
        });
      }

      const result = (await cpFetch(cpUrl, "/session", {
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
    .input(
      z.object({
        connectionId: z.string().min(1),
        cpUrl: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const cpUrl = await resolveCpUrl(input.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      await cpFetch(cpUrl, "/disconnect", {
        method: "POST",
        sessionToken: getSessionToken(ctx.req),
        body: { connectionId: input.connectionId },
      });

      return { success: true };
    }),

  /**
   * Get external source links for an entity.
   * This is a local DB query — no CP involved.
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
