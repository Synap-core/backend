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
import {
  getDb,
  db,
  eq,
  desc,
  entityExternalLinks,
  drizzleSql,
} from "@synap/database";
import { entities, workspaces, workspaceMembers } from "@synap/database/schema";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  enrichmentProviderRegistry,
  getMessagingConnector,
  resolveNangoConnector,
  type UnipileConnector,
} from "../connectors/index.js";
import {
  syncConnectionToImport,
  pullToImport,
} from "../services/connector-import-bridge.js";
import { materializeConnectorTools } from "../connectors/materialize-tools.js";

/**
 * Returns a configured NangoConnector when self-hosted Nango is available,
 * checking env vars first then workspace.settings.nango as fallback.
 * Returns null when neither is configured (pod must use CP-managed Nango).
 *
 * Delegates to the ONE `resolveNangoConnector` resolver in the connector layer
 * so this router and the registry share a single Nango resolution path (the
 * old in-router env→ws.settings duplicate was the dual-Nango drift risk).
 */
async function getLocalNango() {
  return resolveNangoConnector();
}

/**
 * Resolve the workspace an import proposal lands in. A client-supplied
 * `workspaceId` is NEVER trusted as a write scope: the caller must be an editor+
 * member of THAT workspace (else a cross-workspace write-leak). With none named,
 * resolve the user's OWN workspace. Single source of truth for both the
 * connector→import sync and the enrichment→import sink.
 */
async function resolveImportWorkspaceId(
  userId: string,
  requestedWorkspaceId?: string
): Promise<string> {
  const database = await getDb();
  if (requestedWorkspaceId) {
    await assertWorkspaceWrite(database, userId, {
      workspaceId: requestedWorkspaceId,
    });
    return requestedWorkspaceId;
  }
  const membership = await database.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
    columns: { workspaceId: true },
  });
  if (!membership?.workspaceId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No workspace found to scope the import proposal.",
    });
  }
  return membership.workspaceId;
}

async function getEnrichmentKeys(): Promise<{
  apolloApiKey?: string | null;
  apifyToken?: string | null;
}> {
  try {
    const database = await getDb();
    const ws = await database.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const enrichment = ((ws?.settings as Record<string, unknown>)?.enrichment ??
      {}) as Record<string, unknown>;
    return {
      apolloApiKey:
        (enrichment.apolloApiKey as string | null | undefined) || null,
      apifyToken: (enrichment.apifyToken as string | null | undefined) || null,
    };
  } catch {
    return {};
  }
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

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    logger.warn({ path, preview: text.slice(0, 200) }, "CP returned non-JSON");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Connector service returned non-JSON. Check your Control Plane URL. Preview: ${text.slice(0, 100)}`,
    });
  }
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
      const localNango = await getLocalNango();
      if (localNango) {
        const integrations = await localNango.listIntegrations();
        const connections = await localNango.listConnections(ctx.userId);
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
        // Neither local Nango nor CP is configured — return empty list so the
        // UI shows "no connectors" rather than an error.
        return { providers: [], connectorLimit: -1, tier: "local" };
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
      const localNango = await getLocalNango();
      if (localNango) {
        return localNango.listConnections(ctx.userId);
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
   * Materialize the user's connected providers into canonical `tools` rows
   * (+ apply each provider's family capability template).
   *
   * A provider connection (Nango) IS a capability the AI/user can wield, so it
   * belongs in the `tools` table like every other capability. The actual logic
   * lives in the shared `materializeConnectorTools` (also called by the Hub-REST
   * connect door) — this procedure is the browser's trigger: the frontend calls
   * it on the Capabilities mount and after returning from the Connect flow.
   *
   * Intentionally NOT routed through checkPermissionOrPropose(): that gate exists
   * for AI/agent mutations. This is an operator-triggered reconciliation that only
   * materializes facts Nango already holds (the OAuth connection already happened),
   * and it runs on every window-focus — gating it would spam proposals for a no-op.
   * Race-safety + idempotency live in the materializer (pod-wide unique index on
   * `credential_ref`, mig 0132/0140; `hasVerbs` guard on template re-apply).
   */
  syncToolRows: protectedProcedure
    .input(cpUrlInput)
    .mutation(async ({ ctx }) => {
      const localNango = await getLocalNango();
      if (!localNango) {
        // No Nango resolves on this pod — nothing to materialize (no-op).
        return { synced: 0, toolIds: [] as string[] };
      }
      // Delegate to the ONE shared materializer (also used by the Hub-REST
      // connect door) so the browser and the CLI/agent take identical paths.
      const { synced, toolIds } = await materializeConnectorTools(
        ctx as unknown as Parameters<typeof materializeConnectorTools>[0],
        localNango
      );
      return { synced, toolIds };
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
      const localNango = await getLocalNango();
      if (localNango) {
        let workspaceId = input?.workspaceId ?? "";
        if (!workspaceId) {
          // Resolve from DB when not supplied by client
          const database = await getDb();
          const ws = await database.query.workspaces.findFirst();
          workspaceId = ws?.id ?? "unknown";
        }

        // Validate the requested integration key exists in Nango before
        // passing it as allowed_integrations — Nango rejects unknown keys.
        // Fall back to "*" (the picker) ONLY when Nango answered and genuinely
        // doesn't declare it; a failed lookup proves nothing about the key.
        let effectiveProvider = input?.providerId ?? "*";
        if (effectiveProvider !== "*") {
          const declared = await localNango.listIntegrationsResult();
          if (declared.ok) {
            const exists = declared.integrations.some(
              (i) => i.uniqueKey === effectiveProvider
            );
            if (!exists) effectiveProvider = "*";
          }
        }

        let session: Awaited<ReturnType<typeof localNango.createSession>>;
        try {
          session = await localNango.createSession(
            ctx.userId,
            effectiveProvider,
            workspaceId
          );
        } catch (err) {
          logger.error(
            { err, providerId: input?.providerId },
            "Nango session failed"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Could not start a connection session with this pod's Nango. A pod admin needs to check that the integration is fully configured.",
          });
        }
        return {
          token: session.sessionToken,
          // Return the public-facing Connect URL for browser use, NOT the
          // internal API host (e.g. http://eve-arms-nango:3003) which the
          // browser cannot reach.
          nangoHost: localNango.getConnectUrl(),
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
      // podId may be absent on pods provisioned before the CP wrote it to DB.
      // We pass it when available but do not hard-block — the CP will reject if it requires it.
      const podId = cp.podId ?? null;

      const tier = cp.tier ?? "solo";
      const limit = getConnectorLimit(tier);

      if (limit >= 0) {
        const providersResult = (await cpFetch(cpUrl, "/providers", {
          method: "GET",
          sessionToken: getSessionToken(ctx.req),
          query: podId ? { podId } : undefined,
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
          ...(podId ? { podId } : {}),
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
      const localNango = await getLocalNango();
      if (localNango) {
        await localNango.revokeConnection(input.connectionId);
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
   * On-demand "sync this connection now → proposal" (Universal Intake P4).
   *
   * Pulls records for a connected Nango source (connection + model) and routes
   * them through the canonical import ENGINE so the sync lands as ONE governed
   * `import.graph` proposal (review-gated), never a direct write. This is the
   * connector→import bridge — the missing caller for `fetchRecords`.
   *
   * On-demand only; no scheduling (a later phase). Local-Nango only: requires a
   * configured self-hosted Nango on this pod (same gate as the sibling
   * connection procedures).
   */
  syncToImport: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        model: z.string().min(1),
        /** Workspace the resulting proposal is scoped to (defaults to primary). */
        workspaceId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const localNango = await getLocalNango();
      if (!localNango) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Connector→import sync requires self-hosted Nango configured on this pod.",
        });
      }

      const workspaceId = await resolveImportWorkspaceId(
        ctx.userId,
        input.workspaceId
      );

      const result = await syncConnectionToImport({
        ctx: {
          workspaceId,
          userId: ctx.userId,
          trpcCtx: ctx as unknown as Record<string, unknown>,
        },
        connectionId: input.connectionId,
        model: input.model,
        connector: localNango,
      });

      return result;
    }),

  /**
   * Returns the configured/not-configured status of each enrichment provider.
   * Checks workspace settings first (user-configured keys), then env vars.
   */
  enrichmentProviders: protectedProcedure.query(async () => {
    const keys = await getEnrichmentKeys();
    return [
      {
        name: "apollo" as const,
        displayName: "Apollo.io",
        description: "People & company search",
        envVar: "APOLLO_API_KEY",
        capabilities: ["person", "company"] as const,
        configured:
          enrichmentProviderRegistry
            .get("apollo")
            ?.isConfigured(keys.apolloApiKey ?? undefined) ?? false,
        hasCustomKey: !!keys.apolloApiKey,
      },
      {
        name: "apify" as const,
        displayName: "Apify",
        description: "Web scraping & lead generation",
        envVar: "APIFY_API_TOKEN",
        capabilities: ["person", "company", "leads"] as const,
        configured:
          enrichmentProviderRegistry
            .get("apify")
            ?.isConfigured(keys.apifyToken ?? undefined) ?? false,
        hasCustomKey: !!keys.apifyToken,
      },
    ];
  }),

  /**
   * Save enrichment provider API keys to workspace settings.
   * Pass undefined to leave an existing key unchanged; pass empty string to clear it.
   */
  saveEnrichmentKeys: protectedProcedure
    .input(
      z.object({
        apolloApiKey: z.string().optional(),
        apifyToken: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const ws = await database.query.workspaces.findFirst({
        columns: { id: true, settings: true },
      });
      if (!ws)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No workspace found",
        });

      const existing = ((ws.settings as Record<string, unknown>)?.enrichment ??
        {}) as Record<string, unknown>;
      const merged = {
        ...existing,
        ...(input.apolloApiKey !== undefined
          ? { apolloApiKey: input.apolloApiKey || null }
          : {}),
        ...(input.apifyToken !== undefined
          ? { apifyToken: input.apifyToken || null }
          : {}),
      };

      await database
        .update(workspaces)
        .set({
          settings: drizzleSql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({ enrichment: merged })}::jsonb`,
        })
        .where(eq(workspaces.id, ws.id));

      return { success: true };
    }),

  /**
   * Get messaging service configuration status (keys are never returned to the client).
   */
  getMessagingConfig: protectedProcedure.query(async () => {
    const database = await getDb();
    const ws = await database.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cfg = ((ws?.settings as Record<string, unknown>)?.messaging ??
      {}) as Record<string, unknown>;
    const hasDsn =
      !!(cfg.unipileDsn as string | undefined) || !!process.env.UNIPILE_DSN;
    const hasApiKey =
      !!(cfg.unipileApiKey as string | undefined) ||
      !!process.env.UNIPILE_API_KEY;
    const hasWebhookSecret =
      !!(cfg.unipileWebhookSecret as string | undefined) ||
      !!process.env.UNIPILE_WEBHOOK_SECRET;
    const fromEnv = !cfg.unipileDsn && !cfg.unipileApiKey;
    return {
      configured: hasDsn && hasApiKey,
      hasDsn,
      hasApiKey,
      hasWebhookSecret,
      fromEnv,
    };
  }),

  /**
   * Save messaging service credentials to workspace settings.
   * Pass undefined to leave a key unchanged; pass empty string to clear it.
   */
  saveMessagingConfig: protectedProcedure
    .input(
      z.object({
        unipileDsn: z.string().optional(),
        unipileApiKey: z.string().optional(),
        unipileWebhookSecret: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const ws = await database.query.workspaces.findFirst({
        columns: { id: true, settings: true },
      });
      if (!ws)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No workspace found",
        });

      const existing = ((ws.settings as Record<string, unknown>)?.messaging ??
        {}) as Record<string, unknown>;
      const merged = {
        ...existing,
        ...(input.unipileDsn !== undefined
          ? { unipileDsn: input.unipileDsn || null }
          : {}),
        ...(input.unipileApiKey !== undefined
          ? { unipileApiKey: input.unipileApiKey || null }
          : {}),
        ...(input.unipileWebhookSecret !== undefined
          ? { unipileWebhookSecret: input.unipileWebhookSecret || null }
          : {}),
      };

      await database
        .update(workspaces)
        .set({
          settings: drizzleSql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({ messaging: merged })}::jsonb`,
        })
        .where(eq(workspaces.id, ws.id));

      return { success: true };
    }),

  /**
   * Probe for sibling services on the same parent domain as PUBLIC_URL.
   * e.g. pod at https://pod.team.acme.xyz → checks https://nango.team.acme.xyz
   * No user-supplied URLs — derived from the pod's own PUBLIC_URL env var only.
   */
  autodiscover: protectedProcedure.query(async () => {
    const publicUrl = process.env.PUBLIC_URL?.trim();
    const localNango = await getLocalNango();

    let nangoCandidate: {
      url: string;
      reachable: boolean;
      configured: boolean;
    } | null = null;

    if (publicUrl) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(publicUrl);
      } catch {
        // invalid PUBLIC_URL — skip discovery
      }

      if (parsed) {
        const parts = parsed.hostname.split(".");
        // Need at least 3 parts (sub.domain.tld) to swap the first label
        if (parts.length >= 3) {
          const parent = parts.slice(1).join(".");
          const candidateUrl = `${parsed.protocol}//nango.${parent}`;

          let reachable = false;
          try {
            // Try /healthz first, then root — accept any HTTP response (even 401/403)
            const res = await fetch(`${candidateUrl}/healthz`, {
              method: "HEAD",
              signal: AbortSignal.timeout(3000),
            }).catch(() =>
              fetch(candidateUrl, {
                method: "HEAD",
                signal: AbortSignal.timeout(3000),
              })
            );
            reachable = res.status < 500;
          } catch {
            reachable = false;
          }

          nangoCandidate = {
            url: candidateUrl,
            reachable,
            configured: localNango !== null,
          };
        }
      }
    }

    return {
      nango: nangoCandidate ?? {
        url: null,
        reachable: false,
        configured: localNango !== null,
      },
    };
  }),

  /**
   * Get Nango self-hosted configuration status (secrets never returned).
   */
  getNangoConfig: protectedProcedure.query(async () => {
    const database = await getDb();
    const ws = await database.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cfg = ((ws?.settings as Record<string, unknown>)?.nango ??
      {}) as Record<string, unknown>;
    const hasSecretKey =
      !!(cfg.secretKey as string | undefined) || !!process.env.NANGO_SECRET_KEY;
    const fromEnv = !cfg.secretKey && !!process.env.NANGO_SECRET_KEY;
    return {
      configured: hasSecretKey,
      hasSecretKey,
      host: (cfg.host as string | undefined) ?? process.env.NANGO_HOST ?? null,
      connectUrl:
        (cfg.connectUrl as string | undefined) ??
        process.env.NANGO_CONNECT_URL ??
        null,
      fromEnv,
    };
  }),

  /**
   * Save self-hosted Nango credentials to workspace settings.
   * Pass undefined to leave a key unchanged; pass empty string to clear it.
   */
  saveNangoConfig: protectedProcedure
    .input(
      z.object({
        secretKey: z.string().optional(),
        host: z.string().optional(),
        connectUrl: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const ws = await database.query.workspaces.findFirst({
        columns: { id: true, settings: true },
      });
      if (!ws)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No workspace found",
        });

      const existing = ((ws.settings as Record<string, unknown>)?.nango ??
        {}) as Record<string, unknown>;
      const merged = {
        ...existing,
        ...(input.secretKey !== undefined
          ? { secretKey: input.secretKey || null }
          : {}),
        ...(input.host !== undefined ? { host: input.host || null } : {}),
        ...(input.connectUrl !== undefined
          ? { connectUrl: input.connectUrl || null }
          : {}),
      };

      await database
        .update(workspaces)
        .set({
          settings: drizzleSql`COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({ nango: merged })}::jsonb`,
        })
        .where(eq(workspaces.id, ws.id));

      // Bust the local nango cache so next call re-reads from DB
      cpSettingsCache = null;

      return { success: true };
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
        /**
         * When true, the enrichment results ALSO flow into the unified governed
         * import sink (one reviewable `import.graph` proposal) — the SAME path
         * Nango records take. The raw `results` are still returned so callers
         * that merge inline keep working; `proposalId` carries the sink proposal.
         */
        landInPod: z.boolean().optional(),
        /** Workspace to land the proposal in (asserted as a write scope). */
        workspaceId: z.string().optional(),
        /** Session to attach the landed proposal to. */
        sessionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const keys = await getEnrichmentKeys();
      const apiKey =
        input.provider === "apollo"
          ? (keys.apolloApiKey ?? undefined)
          : (keys.apifyToken ?? undefined);

      const provider = enrichmentProviderRegistry.get(input.provider);
      if (!provider) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Enrichment provider "${input.provider}" not registered`,
        });
      }
      if (!provider.isConfigured(apiKey)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Enrichment provider "${input.provider}" is not configured — add an API key in Settings → Enrichment`,
        });
      }
      if (!provider.capabilities.includes(input.capability)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider "${input.provider}" does not support capability "${input.capability}"`,
        });
      }

      let results: Awaited<ReturnType<typeof provider.enrich>>;
      try {
        results = await provider.enrich(input.input, apiKey);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Enrichment request failed";
        logger.warn(
          { provider: input.provider, err },
          "Enrichment provider error"
        );
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }

      // LOCKED W4 behavior: enrichment results unify onto the governed import
      // sink (reviewable proposal), like Nango records. Opt-in via `landInPod`
      // so the existing inline-merge caller is unchanged when the flag is unset.
      let proposalId: string | null = null;
      if (input.landInPod) {
        const workspaceId = await resolveImportWorkspaceId(
          ctx.userId,
          input.workspaceId
        );
        const landed = await pullToImport({
          ctx: {
            workspaceId,
            userId: ctx.userId,
            trpcCtx: ctx as unknown as Record<string, unknown>,
            sessionId: input.sessionId ?? null,
          },
          // Read via the registry-keyed enrichment connector (apify/apollo).
          connector: input.provider,
          request: {
            kind: "enrichment",
            capability: input.capability,
            input: input.input,
            apiKey,
          },
        });
        proposalId = landed.proposalId;
      }

      return { results, proposalId };
    }),

  /**
   * Probe every external service and return real health status.
   * Used by the settings health panel so users can see exactly what's
   * failing and why without reading server logs.
   */
  diagnose: protectedProcedure.query(async () => {
    type ServiceHealth = {
      configured: boolean;
      reachable: boolean;
      authenticated: boolean;
      error: string | null;
    };

    async function probeNango(): Promise<ServiceHealth> {
      const n = await getLocalNango();
      if (!n)
        return {
          configured: false,
          reachable: false,
          authenticated: false,
          error: "No secret key configured",
        };
      const result = await n.probe();
      return { configured: true, ...result };
    }

    async function probeUnipile(): Promise<ServiceHealth> {
      const connector = await getMessagingConnector();
      if (!connector)
        return {
          configured: false,
          reachable: false,
          authenticated: false,
          error: "DSN or API key not configured",
        };
      // TODO(W3/W4): becomes a capability cast (Credentialed/probe()).
      const result = await (connector as UnipileConnector).probe();
      return { configured: true, ...result };
    }

    async function probeApollo(
      apiKey: string | null | undefined
    ): Promise<ServiceHealth> {
      if (!apiKey)
        return {
          configured: false,
          reachable: false,
          authenticated: false,
          error: "No API key configured",
        };
      try {
        const res = await fetch("https://api.apollo.io/v1/auth/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401 || res.status === 403) {
          return {
            configured: true,
            reachable: true,
            authenticated: false,
            error: "Invalid API key",
          };
        }
        if (!res.ok) {
          return {
            configured: true,
            reachable: true,
            authenticated: false,
            error: `Apollo returned ${res.status}`,
          };
        }
        return {
          configured: true,
          reachable: true,
          authenticated: true,
          error: null,
        };
      } catch (err) {
        return {
          configured: true,
          reachable: false,
          authenticated: false,
          error: `Cannot reach Apollo: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    async function probeApify(
      token: string | null | undefined
    ): Promise<ServiceHealth> {
      if (!token)
        return {
          configured: false,
          reachable: false,
          authenticated: false,
          error: "No token configured",
        };
      try {
        const res = await fetch(
          `https://api.apify.com/v2/users/me?token=${token}`,
          {
            signal: AbortSignal.timeout(8000),
          }
        );
        if (res.status === 401 || res.status === 403) {
          return {
            configured: true,
            reachable: true,
            authenticated: false,
            error: "Invalid token",
          };
        }
        if (!res.ok) {
          return {
            configured: true,
            reachable: true,
            authenticated: false,
            error: `Apify returned ${res.status}`,
          };
        }
        return {
          configured: true,
          reachable: true,
          authenticated: true,
          error: null,
        };
      } catch (err) {
        return {
          configured: true,
          reachable: false,
          authenticated: false,
          error: `Cannot reach Apify: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const keys = await getEnrichmentKeys();
    const [nango, unipile, apollo, apify] = await Promise.all([
      probeNango(),
      probeUnipile(),
      probeApollo(keys.apolloApiKey),
      probeApify(keys.apifyToken),
    ]);

    return { nango, unipile, apollo, apify };
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
   * Sync status per provider for the current workspace.
   * Returns the most recent lastSyncedAt + entity count per provider.
   * Used to display "Last synced X ago" on connector cards.
   */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        provider: entityExternalLinks.provider,
        connectionId: entityExternalLinks.nangoConnectionId,
        lastSyncedAt: entityExternalLinks.lastSyncedAt,
      })
      .from(entityExternalLinks)
      .orderBy(desc(entityExternalLinks.lastSyncedAt));

    // Collapse to one row per provider for the current user's connections.
    // Connection IDs are `{userId}:{podId}:{provider}` — filter by userId prefix.
    const byProvider = new Map<
      string,
      { lastSyncedAt: Date; entityCount: number }
    >();

    for (const r of rows) {
      if (!r.connectionId.startsWith(ctx.userId + ":")) continue;
      const existing = byProvider.get(r.provider);
      if (!existing) {
        byProvider.set(r.provider, {
          lastSyncedAt: r.lastSyncedAt,
          entityCount: 1,
        });
      } else {
        existing.entityCount++;
        if (r.lastSyncedAt > existing.lastSyncedAt) {
          existing.lastSyncedAt = r.lastSyncedAt;
        }
      }
    }

    return Array.from(byProvider.entries()).map(([provider, info]) => ({
      provider,
      lastSyncedAt: info.lastSyncedAt,
      entityCount: info.entityCount,
    }));
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
