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
 * Tier gating: Solo (free) = 1 connector. Any paid tier = unlimited.
 *
 * Procedures:
 *   connectors.providers   — List available providers with connection status + limits
 *   connectors.connections — List user's active connections
 *   connectors.session     — Get Nango Connect session token for OAuth UI
 *   connectors.disconnect  — Revoke a connection
 *   connectors.entitySources — Get external links for an entity (local DB)
 */

import { z } from "zod";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { config, createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { getDb, db, eq, desc, entityExternalLinks } from "@synap/database";
import { entities, workspaces } from "@synap/database/schema";
import { NangoConnector } from "../connectors/NangoConnector.js";
import { enrichmentProviderRegistry } from "../connectors/index.js";

const nango = new NangoConnector();

/** True when Nango is self-hosted on this pod (NANGO_SECRET_KEY env var set). */
function isLocalNango(): boolean {
  return nango.isConfigured();
}

const logger = createLogger({ module: "connectors-trpc" });

// ─── Connector limits per tier ───────────────────────────────────────────────

/** -1 = unlimited */
const CONNECTOR_LIMITS: Record<string, number> = {
  solo: 1,
  pro: -1,
  team: -1,
  enterprise: -1,
};

function getConnectorLimit(tier: string): number {
  return CONNECTOR_LIMITS[tier] ?? CONNECTOR_LIMITS.solo!;
}

// ─── Cached workspace controlPlane settings ──────────────────────────────────

const CACHE_TTL = 5 * 60_000; // 5 min

interface ControlPlaneSettings {
  url?: string;
  podId?: string;
  tier?: string;
  allowedUrls?: string[];
}

interface CacheEntry<T> {
  value: T;
  resolvedAt: number;
}

let cpSettingsCache: CacheEntry<ControlPlaneSettings> | null = null;

/**
 * Read workspace.settings.controlPlane from the DB (cached 5 min).
 * This block is written by the provision flow (ES256 JWT from CP).
 */
async function getControlPlaneSettings(): Promise<ControlPlaneSettings> {
  if (cpSettingsCache && Date.now() - cpSettingsCache.resolvedAt < CACHE_TTL) {
    return cpSettingsCache.value;
  }

  try {
    const database = await getDb();
    const ws = await database.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const settings = (ws?.settings as Record<string, unknown>) ?? {};
    const cp = (settings.controlPlane as ControlPlaneSettings) ?? {};

    if (!cp.url) {
      logger.warn(
        { hasWorkspace: !!ws, hasControlPlane: !!cp.podId },
        "No controlPlane.url in workspace settings — pod may need re-provisioning"
      );
    }

    cpSettingsCache = { value: cp, resolvedAt: Date.now() };
    return cp;
  } catch (err) {
    logger.error(
      { err },
      "Failed to read controlPlane settings from workspace"
    );
    return {};
  }
}

// ─── CP URL validation (SSRF prevention) ─────────────────────────────────────

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/** Blocked hostnames / IP patterns for SSRF prevention. */
const SSRF_BLOCKED = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /\.(internal|local|localhost)$/i,
];

/**
 * Validate a CP URL for safety (SSRF prevention).
 *
 * Strategy (layered):
 *   1. If the pod has a provisioned allowlist (DB or env var), validate against it.
 *   2. Otherwise, allow any public HTTPS URL (the pod is already auth-gated).
 *      This handles pods that were provisioned before controlPlane.url was stored.
 *
 * Always blocked: private IPs, localhost, non-HTTPS.
 */
async function validateCpUrl(requestedUrl: string): Promise<string> {
  const cleaned = requestedUrl.replace(/\/+$/, "");

  // Basic safety: must be HTTPS, no private/internal targets
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid Control Plane URL",
    });
  }

  if (parsed.protocol !== "https:") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Control Plane URL must use HTTPS",
    });
  }

  if (SSRF_BLOCKED.some((re) => re.test(parsed.hostname))) {
    logger.warn({ requestedUrl }, "Blocked SSRF attempt on CP URL");
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Control Plane URL points to a private network",
    });
  }

  // Prefer explicit allowlist when available
  const cp = await getControlPlaneSettings();
  const allowedUrls: string[] = [];

  if (cp.url) allowedUrls.push(normalize(cp.url));
  if (Array.isArray(cp.allowedUrls)) {
    for (const u of cp.allowedUrls) {
      if (typeof u === "string") allowedUrls.push(normalize(u));
    }
  }
  if (config.server.controlPlaneUrl) {
    allowedUrls.push(normalize(config.server.controlPlaneUrl));
  }

  if (allowedUrls.length > 0) {
    // Strict mode: check against provisioned allowlist
    if (allowedUrls.includes(normalize(cleaned))) {
      return cleaned;
    }
    logger.warn(
      { requestedUrl, allowedUrls },
      "CP URL not in provisioned allowlist"
    );
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Control Plane URL not in allowlist. Allowed: ${allowedUrls.join(", ")}`,
    });
  }

  // No allowlist configured — pod may need re-provisioning.
  logger.warn(
    { requestedUrl, hasPodId: !!cp.podId },
    "No CP URL allowlist configured — rejecting request"
  );
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "No Control Plane URL configured. The pod needs to be re-provisioned.",
  });
}

/**
 * Resolve CP URL: use frontend-provided URL (validated) or fall back to
 * the provisioned URL.
 */
async function resolveCpUrl(
  frontendUrl: string | undefined
): Promise<string | null> {
  if (frontendUrl) return validateCpUrl(frontendUrl);

  // Fallback: provisioned URL
  const cp = await getControlPlaneSettings();
  if (cp.url) return cp.url.replace(/\/+$/, "");
  if (config.server.controlPlaneUrl) {
    return config.server.controlPlaneUrl.replace(/\/+$/, "");
  }
  return null;
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
   * Also returns the connector limit for the current tier.
   *
   * Local mode: reads integrations directly from self-hosted Nango.
   * CP mode: proxies to Control Plane.
   */
  providers: protectedProcedure
    .input(cpUrlInput)
    .query(async ({ ctx, input }) => {
      if (isLocalNango()) {
        const integrations = await nango.listIntegrations();
        const connections = await nango.listConnections(ctx.userId);
        const connectedProviders = new Set(connections.map((c) => c.provider));
        return {
          providers: integrations.map((i) => ({
            id: i.uniqueKey,
            provider: i.provider,
            displayName: i.displayName,
            connected: connectedProviders.has(i.uniqueKey),
          })),
          connectorLimit: -1,
          tier: "local",
        };
      }

      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const cp = await getControlPlaneSettings();
      const podId = cp.podId ?? null;
      const tier = cp.tier ?? "solo";
      const limit = getConnectorLimit(tier);

      const result = (await cpFetch(cpUrl, "/providers", {
        method: "GET",
        sessionToken: getSessionToken(ctx.req),
        query: podId ? { podId } : undefined,
      })) as { providers: unknown[] };

      return {
        providers: result.providers,
        connectorLimit: limit,
        tier,
      };
    }),

  /**
   * List user's active connections for this pod.
   *
   * Local mode: queries self-hosted Nango directly.
   * CP mode: proxies to Control Plane.
   */
  connections: protectedProcedure
    .input(cpUrlInput)
    .query(async ({ ctx, input }) => {
      if (isLocalNango()) {
        return nango.listConnections(ctx.userId);
      }

      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const cp = await getControlPlaneSettings();
      const podId = cp.podId ?? null;

      const result = (await cpFetch(cpUrl, "/connections", {
        method: "GET",
        sessionToken: getSessionToken(ctx.req),
        query: podId ? { podId } : undefined,
      })) as { connections: unknown[] };

      return result.connections;
    }),

  /**
   * Get a Nango Connect session token for the OAuth UI.
   *
   * Local mode: creates session directly on self-hosted Nango — no CP needed.
   * CP mode: proxies to CP which enforces tier-based connector limits.
   */
  session: protectedProcedure
    .input(
      z
        .object({
          cpUrl: z.string().url().optional(),
          /** Restrict session to a single provider (skips Nango picker). */
          providerId: z.string().min(1).optional(),
          /** Workspace context for metadata (optional, defaults to user's primary workspace). */
          workspaceId: z.string().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      if (isLocalNango()) {
        let workspaceId = input?.workspaceId ?? "";
        if (!workspaceId) {
          // Resolve from DB when not supplied by client
          const database = await getDb();
          const ws = await database.query.workspaces.findFirst();
          workspaceId = ws?.id ?? "unknown";
        }

        const session = await nango.createSession(
          ctx.userId,
          input?.providerId ?? "*",
          workspaceId
        );
        return {
          token: session.sessionToken,
          nangoHost: process.env.NANGO_HOST ?? "http://localhost:3003",
          connectLink: session.redirectUrl,
        };
      }

      const cpUrl = await resolveCpUrl(input?.cpUrl);
      if (!cpUrl) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Control Plane configured",
        });
      }

      const cp = await getControlPlaneSettings();
      const podId = cp.podId ?? null;
      if (!podId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Pod ID not configured",
        });
      }

      const tier = cp.tier ?? "solo";
      const limit = getConnectorLimit(tier);

      if (limit >= 0) {
        const providersResult = (await cpFetch(cpUrl, "/providers", {
          method: "GET",
          sessionToken: getSessionToken(ctx.req),
          query: { podId },
        })) as {
          providers: Array<{ connected?: boolean }>;
        };

        const connectedCount = providersResult.providers.filter(
          (p) => p.connected
        ).length;

        if (connectedCount >= limit) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Free plan allows ${limit} connector${limit === 1 ? "" : "s"}. Upgrade to connect more services.`,
          });
        }
      }

      const result = (await cpFetch(cpUrl, "/session", {
        method: "POST",
        sessionToken: getSessionToken(ctx.req),
        body: {
          podId,
          ...(input?.providerId ? { providerId: input.providerId } : {}),
        },
      })) as { token: string; nangoHost?: string; connectLink?: string };

      return {
        token: result.token,
        nangoHost: result.nangoHost,
        connectLink: result.connectLink,
      };
    }),

  /**
   * Disconnect a connector.
   *
   * Local mode: revokes connection directly on self-hosted Nango.
   * CP mode: proxies to Control Plane.
   */
  disconnect: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        cpUrl: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (isLocalNango()) {
        await nango.revokeConnection(input.connectionId);
        return { success: true };
      }

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
   * Returns the configured/not-configured status of each enrichment provider.
   * Used by settings UI to show API key status without exposing the keys.
   */
  enrichmentProviders: protectedProcedure.query(() => {
    const providers = [
      {
        name: "apollo" as const,
        displayName: "Apollo.io",
        description: "People & company search",
        envVar: "APOLLO_API_KEY",
        capabilities: ["person", "company"] as const,
        configured:
          enrichmentProviderRegistry.get("apollo")?.isConfigured() ?? false,
      },
      {
        name: "apify" as const,
        displayName: "Apify",
        description: "Web scraping & lead generation",
        envVar: "APIFY_TOKEN",
        capabilities: ["person", "company", "leads"] as const,
        configured:
          enrichmentProviderRegistry.get("apify")?.isConfigured() ?? false,
      },
    ];
    return providers;
  }),

  /**
   * Enrich an entity using an external enrichment provider (Apify, Apollo.io).
   * Returns structured data that the caller can merge into entity properties.
   */
  enrich: protectedProcedure
    .input(
      z.object({
        provider: z.enum(["apify", "apollo"]),
        capability: z.enum(["person", "company", "leads"]),
        input: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input }) => {
      const provider = enrichmentProviderRegistry.get(input.provider);
      if (!provider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Enrichment provider "${input.provider}" not registered`,
        });
      }
      if (!provider.isConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Enrichment provider "${input.provider}" is not configured — check API key`,
        });
      }
      if (!provider.capabilities.includes(input.capability)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider "${input.provider}" does not support capability "${input.capability}"`,
        });
      }

      const results = await provider.enrich(input.input);
      return { results };
    }),

  /**
   * Diagnostic: returns what the pod sees for CP connection settings.
   * Helps debug provisioning issues.
   */
  status: protectedProcedure.query(async () => {
    const cp = await getControlPlaneSettings();
    const allowedUrls: string[] = [];
    if (cp.url) allowedUrls.push(cp.url);
    if (Array.isArray(cp.allowedUrls)) allowedUrls.push(...cp.allowedUrls);
    if (config.server.controlPlaneUrl)
      allowedUrls.push(config.server.controlPlaneUrl);
    return {
      controlPlane: {
        url: cp.url ?? null,
        podId: cp.podId ?? null,
        tier: cp.tier ?? null,
        hasSettings: !!(cp.url || cp.podId),
      },
      allowedCpUrls: allowedUrls,
      envVar: config.server.controlPlaneUrl ?? null,
    };
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

  /**
   * Pod Admin: list ALL active connections across every workspace on this pod.
   *
   * Connections are tracked locally via `entity_external_links` (one row per
   * external record synced through Nango). We collapse to one row per
   * (provider, nangoConnectionId) so the Pod Admin grid shows distinct
   * connections rather than every synced entity.
   *
   * The connection's effective workspace is inferred from the linked entity's
   * `workspaceId`. JOINing against `workspaces` populates `workspaceName` so
   * the grid can group by workspace without an extra round-trip.
   *
   * `accountEmail` is not stored on the pod (it lives on the CP) — returned
   * as `null` for now; clients should hydrate it from the CP if needed.
   */
  allConnections: podAdminProcedure.query(async () => {
    // Collect every (connectionId, provider) pair with the most recent
    // sync timestamp + first-seen createdAt + originating entity.
    const rows = await db
      .select({
        connectionId: entityExternalLinks.nangoConnectionId,
        providerId: entityExternalLinks.provider,
        status: entityExternalLinks.status,
        lastSyncedAt: entityExternalLinks.lastSyncedAt,
        createdAt: entityExternalLinks.createdAt,
        workspaceId: entities.workspaceId,
        workspaceName: workspaces.name,
      })
      .from(entityExternalLinks)
      .leftJoin(entities, eq(entityExternalLinks.entityId, entities.id))
      .leftJoin(workspaces, eq(entities.workspaceId, workspaces.id))
      .orderBy(desc(entityExternalLinks.lastSyncedAt));

    // Collapse to one row per (provider, connectionId) — keep the most
    // recent lastSyncedAt and the earliest createdAt observed.
    type ConnectionRow = {
      connectionId: string;
      providerId: string;
      workspaceId: string | null;
      workspaceName: string | null;
      accountEmail: string | null;
      status: string;
      lastSyncedAt: Date;
      createdAt: Date;
    };

    const grouped = new Map<string, ConnectionRow>();
    for (const r of rows) {
      const key = `${r.providerId}::${r.connectionId}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          connectionId: r.connectionId,
          providerId: r.providerId,
          workspaceId: r.workspaceId ?? null,
          workspaceName: r.workspaceName ?? null,
          accountEmail: null,
          status: r.status,
          lastSyncedAt: r.lastSyncedAt,
          createdAt: r.createdAt,
        });
      } else {
        if (r.lastSyncedAt > existing.lastSyncedAt) {
          existing.lastSyncedAt = r.lastSyncedAt;
          existing.status = r.status;
        }
        if (r.createdAt < existing.createdAt) {
          existing.createdAt = r.createdAt;
        }
      }
    }

    return Array.from(grouped.values());
  }),
});
