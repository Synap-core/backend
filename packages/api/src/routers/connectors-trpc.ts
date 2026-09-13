/**
 * Connectors tRPC Router
 *
 * Every connection operation goes through the ONE broker seam
 * (`resolveBroker`): the Control Plane broker on a CP-managed pod (no Nango key
 * on the pod; the CP brokers in the pod's namespace and enforces tier limits),
 * or this pod's own vault key when self-hosted. No procedure branches on which.
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
  and,
  inArray,
  isNull,
  isNotNull,
  entityExternalLinks,
  drizzleSql,
  upsertServiceSecret,
  getServiceSecret,
  isServerVaultAvailable,
  getWorkspaceMembership,
} from "@synap/database";
import {
  secrets,
  tools,
  workspaces,
  workspaceMembers,
} from "@synap/database/schema";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  BrokerRefusalError,
  enrichmentProviderRegistry,
  getMessagingConnector,
  isControlPlaneBrokered,
  resolveBroker,
  resolveNangoConnector,
  migrateNangoEnvToVault,
  resolvePodConnectorWorkspace,
  type ConnectionBroker,
  type UnipileConnector,
} from "../connectors/index.js";
import {
  syncConnectionToImport,
  pullToImport,
} from "../services/connector-import-bridge.js";
import {
  annotatePendingInstall,
  annotateProviderPendingInstall,
  materializeConnectorTools,
  type MaterializeResult,
} from "../connectors/materialize-tools.js";
import {
  disconnectOwnedConnection,
  enqueueManualConnectionSync,
  reconcileLiveConnections,
  setConnectionKeepSyncing,
} from "../services/capabilities/capability-nango-sync.js";
import { resolveCapabilityNangoProviderKeys } from "../services/capabilities/capability-provider-resolution.js";
import { getConnectionSyncStatus } from "../services/event-sync/connection-sync.js";
import { loadProviderSyncKinds } from "../connectors/sync-kinds.js";
import type { SyncConnectorConnection } from "../connectors/SyncConnector.js";

/**
 * A pod brokered by its control plane must never take a LOCAL Nango key: it
 * would bypass the broker's per-pod namespace.
 */
function refuseOnBrokeredPod(): void {
  if (isControlPlaneBrokered()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This pod's connections are brokered by its control plane, so a local Nango key would bypass the broker. To self-host connectors instead, set SYNAP_CONNECTOR_BROKER=local on the pod.",
    });
  }
}

/**
 * First observation of a connection, reached by the client's post-OAuth refetch:
 * make sure its provider tool exists and carries its family template
 * (materialize), then mirror it into the connection registry — which enqueues
 * its first sync. Idempotent. A failure is logged and does not fail the list,
 * which the broker answered.
 *
 * Returns the providers whose template install is waiting on an approval: the
 * governed apply filed proposals instead of installing, so the connection has
 * no capability, no registry row and no sync until someone approves.
 */
async function mirrorObservedConnections(
  ctx: Parameters<typeof materializeConnectorTools>[0],
  broker: ConnectionBroker,
  connections: SyncConnectorConnection[]
): Promise<MaterializeResult["pendingInstall"]> {
  if (connections.length === 0) return [];
  let pendingInstall: MaterializeResult["pendingInstall"] = [];
  try {
    const refs = [...new Set(connections.map((c) => `nango://${c.provider}`))];
    const existing = await db
      .select({ ref: tools.credentialRef, capabilities: tools.capabilities })
      .from(tools)
      .where(
        and(inArray(tools.credentialRef, refs), isNull(tools.workspaceId))
      );
    // A tool without verbs is a template apply that has not landed (yet, or
    // pending approval): materialize again — the governed apply is idempotent.
    const installed = new Set(
      existing
        .filter(
          (t) => Array.isArray(t.capabilities) && t.capabilities.length > 0
        )
        .map((t) => t.ref)
    );
    if (installed.size < refs.length) {
      pendingInstall = (await materializeConnectorTools(ctx, broker))
        .pendingInstall;
    }
    await reconcileLiveConnections(ctx.userId!, connections);
  } catch (err) {
    logger.warn(
      { err },
      "connections: could not mirror newly observed connections (the list itself was returned)"
    );
  }
  return pendingInstall;
}

/**
 * This pod's OWN Nango key (vault → env → legacy settings), or null. Only the
 * Records-API import path (`syncToImport`) still needs the concrete local
 * connector; every connection operation goes through `requireBroker`.
 */
async function getLocalNango() {
  return resolveNangoConnector();
}

/**
 * The connection broker, or a TRPCError that names the real cause. "No broker"
 * is a precondition; a broker that is configured but unreadable is a fault.
 */
async function requireBroker(): Promise<ConnectionBroker> {
  const resolved = await resolveBroker("nango");
  if (resolved.ok) return resolved.broker;
  if (resolved.reason === "not-configured") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No connection broker is configured on this pod.",
    });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `This pod's connection broker is unavailable (${resolved.reason}): ${resolved.error}`,
  });
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

/**
 * Resolve the pod's connector-config workspace.
 *
 * A connector credential is POD infrastructure, not workspace content: one
 * Nango key serves every workspace. So membership in a workspace is the WRONG
 * gate — `workspaces.create` sets `ownerId: ctx.userId` and auto-adds the
 * creator as owner, so any authenticated user could self-grant owner and clear
 * a per-workspace check. These procedures are `podAdminProcedure` instead, and
 * the identity is pinned to the same workspace the resolver reads
 * (`resolvePodConnectorWorkspace`) so the two cannot disagree.
 */
async function requirePodConnectorWorkspace(): Promise<{
  id: string;
  ownerId: string | null;
  settings: unknown;
}> {
  const ws = await resolvePodConnectorWorkspace();
  if (!ws)
    throw new TRPCError({ code: "NOT_FOUND", message: "No workspace found" });
  return ws;
}

/**
 * The user the vault stores a workspace's pod-infra credentials under.
 * Convention: `workspace.ownerId` (see `connectors/index.ts:215,232`).
 */
function vaultOwnerFor(ws: { ownerId: string | null }): string {
  if (!ws.ownerId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Workspace has no owner; cannot store connector credentials in the vault.",
    });
  }
  return ws.ownerId;
}

/**
 * Fail LOUDLY when the server vault is unavailable rather than silently
 * writing a plaintext credential into `workspace.settings` — silent fallback is
 * exactly the bug class this wave removes. `VAULT_SERVER_KEY` is strict-required
 * in deploy (`${VAULT_SERVER_KEY:?…}`), so this only trips on a misconfigured pod.
 */
function assertVaultWritable(): void {
  if (!isServerVaultAvailable()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Server vault unavailable (VAULT_SERVER_KEY unset) — refusing to store credentials in plaintext workspace settings.",
    });
  }
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

// ─── Shared input schema ──────────────────────────────────────────────────────

/**
 * Accepted for backward compatibility and IGNORED: the pod no longer forwards a
 * client-named Control Plane URL (the broker's CP URL is server config).
 * Added 2026-09-13; remove once no shipped client sends `cpUrl` (relay and
 * browser stopped on 2026-09-13), no earlier than 2026-12-01.
 */
const cpUrlInput = z.object({ cpUrl: z.string().url().optional() }).optional();

// ─── Router ───────────────────────────────────────────────────────────────────

export const connectorsRouter = router({
  /**
   * List available providers with their connection status for this pod.
   *
   * `connectorLimit` is always -1: the pod never enforces a limit. The broker is
   * the ONE enforcement point and refuses an over-limit session
   * (`FORBIDDEN`, broker code `CONNECTOR_LIMIT`).
   */
  providers: protectedProcedure.input(cpUrlInput).query(async ({ ctx }) => {
    // The pod does not know its plan: the broker enforces limits. `tier` says
    // only who brokers — "managed" (the control plane) or "local".
    const tier = isControlPlaneBrokered() ? "managed" : "local";
    const resolved = await resolveBroker("nango");

    if (!resolved.ok) {
      // Genuinely nothing configured is the ONE state that may render as an
      // empty list. A configured-but-unreadable broker is a fault, reported as
      // such — never as "this pod has no connectors".
      if (resolved.reason === "not-configured") {
        return {
          providers: [],
          connectorLimit: -1,
          tier,
          nangoStatus: "ok" as const,
        };
      }
      return {
        providers: [],
        connectorLimit: -1,
        tier,
        nangoStatus: "error" as const,
        nangoError: { reason: resolved.reason, message: resolved.error },
      };
    }

    const [declared, listed] = await Promise.all([
      resolved.broker.listIntegrationsResult(),
      resolved.broker.listConnectionsResult(ctx.userId),
    ]);
    if (!declared.ok || !listed.ok) {
      const fault = !declared.ok
        ? declared
        : (listed as Extract<typeof listed, { ok: false }>);
      return {
        providers: [],
        connectorLimit: -1,
        tier,
        nangoStatus: "error" as const,
        nangoError: { reason: fault.reason, message: fault.error },
      };
    }
    const connectionByProvider = new Map<string, string>();
    for (const c of listed.connections) {
      if (!connectionByProvider.has(c.provider)) {
        connectionByProvider.set(c.provider, c.connectionId);
      }
    }
    // What each connection brings, before connecting. `undefined` = unknown
    // (template unreadable), `[]` = brings nothing.
    const syncKindsByProvider = await loadProviderSyncKinds(
      declared.integrations.map((i) => i.uniqueKey)
    );
    // A connection whose install waits for an admin is not "connected": the
    // same mirror source `connections` annotates its rows from (idempotent;
    // re-applies only while a provider tool has no verbs yet).
    const pendingInstall = await mirrorObservedConnections(
      ctx as unknown as Parameters<typeof materializeConnectorTools>[0],
      resolved.broker,
      listed.connections
    );
    return {
      providers: annotateProviderPendingInstall(
        declared.integrations.map((i) => ({
          id: i.uniqueKey,
          provider: i.provider,
          displayName: i.displayName,
          connected: connectionByProvider.has(i.uniqueKey),
          connectionId: connectionByProvider.get(i.uniqueKey),
          syncKinds: syncKindsByProvider.get(i.uniqueKey),
        })),
        pendingInstall
      ),
      connectorLimit: -1,
      tier,
      nangoStatus: "ok" as const,
    };
  }),

  /**
   * List the user's live connections. A failed read THROWS — an empty array
   * means the broker answered and the user has no connections.
   *
   * A deliberately SIDE-EFFECTING read: it is the client's post-OAuth refetch,
   * so it also materializes a missing provider tool, mirrors new connections
   * into the registry and enqueues their first sync. Every step is idempotent
   * (about four queries in steady state), and a mirror failure is logged
   * without failing the list the broker answered.
   */
  connections: protectedProcedure.input(cpUrlInput).query(async ({ ctx }) => {
    const broker = await requireBroker();
    const listed = await broker.listConnectionsResult(ctx.userId);
    if (!listed.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Could not list connections (${listed.reason}): ${listed.error}`,
      });
    }
    const pendingInstall = await mirrorObservedConnections(
      ctx as unknown as Parameters<typeof materializeConnectorTools>[0],
      broker,
      listed.connections
    );
    return annotatePendingInstall(listed.connections, pendingInstall);
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
      const resolved = await resolveBroker("nango");
      if (!resolved.ok && resolved.reason === "not-configured") {
        // No broker on this pod — nothing to materialize (no-op).
        return { synced: 0, toolIds: [] as string[] };
      }
      const broker = await requireBroker();
      // Delegate to the ONE shared materializer (also used by the Hub-REST
      // connect door) so the browser and the CLI/agent take identical paths.
      const { synced, toolIds } = await materializeConnectorTools(
        ctx as unknown as Parameters<typeof materializeConnectorTools>[0],
        broker
      );
      return { synced, toolIds };
    }),

  /**
   * Get a Connect session for the OAuth UI, through the broker. On a CP-managed
   * pod the CP stamps the pod's namespace and enforces the plan's connector
   * limit; an over-limit request is FORBIDDEN.
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
      const broker = await requireBroker();

      let workspaceId = input?.workspaceId ?? "";
      if (!workspaceId) {
        // Resolve from DB when not supplied by client
        const database = await getDb();
        const ws = await database.query.workspaces.findFirst();
        workspaceId = ws?.id ?? "unknown";
      }

      // Validate the requested integration key is declared before passing it as
      // allowed_integrations — Nango rejects unknown keys. Fall back to "*" (the
      // picker) ONLY when the broker answered and genuinely doesn't declare it;
      // a failed lookup proves nothing about the key.
      let effectiveProvider = input?.providerId ?? "*";
      if (effectiveProvider !== "*") {
        const declared = await broker.listIntegrationsResult();
        if (declared.ok) {
          const exists = declared.integrations.some(
            (i) => i.uniqueKey === effectiveProvider
          );
          if (!exists) effectiveProvider = "*";
        }
      }

      let session: Awaited<ReturnType<ConnectionBroker["createSession"]>>;
      try {
        session = await broker.createSession(
          ctx.userId,
          effectiveProvider,
          workspaceId
        );
      } catch (err) {
        if (err instanceof BrokerRefusalError) {
          throw new TRPCError({
            code:
              err.code === "CONNECTOR_LIMIT"
                ? "FORBIDDEN"
                : "PRECONDITION_FAILED",
            message: err.message,
          });
        }
        logger.error(
          { err, providerId: input?.providerId, mode: broker.mode },
          "Connect session failed"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not start a connection session. A pod admin needs to check that the integration is fully configured.",
        });
      }
      return {
        token: session.sessionToken,
        // The public-facing Connect URL for browser use, never an internal API
        // host the browser cannot reach. The CP broker returns a full link.
        nangoHost: broker.getConnectUrl() ?? undefined,
        connectLink: session.redirectUrl,
      };
    }),

  /**
   * Disconnect one of the caller's own connections through the broker.
   */
  disconnect: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        cpUrl: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const broker = await requireBroker();
      const outcome = await disconnectOwnedConnection({
        broker,
        userId: ctx.userId,
        connectionId: input.connectionId,
      });
      if (!outcome.ok) {
        throw new TRPCError({
          code:
            outcome.reason === "not_found"
              ? "NOT_FOUND"
              : "INTERNAL_SERVER_ERROR",
          message: outcome.error,
        });
      }
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
   * Save enrichment provider API keys.
   * Pass undefined to leave an existing key unchanged; pass empty string to clear it.
   *
   * SECURITY: requires admin/owner of the named workspace — see
   * `requirePodConnectorWorkspace`.
   *
   * ⚠️ STORAGE DEBT: these keys still land in the PLAINTEXT `settings.enrichment`
   * blob. Unlike nango/messaging, enrichment has NO established vault serviceId
   * or vault-reading resolver, so moving it is a design decision (new serviceId
   * convention + a rewrite of `getEnrichmentKeys` and the providers status
   * endpoint) rather than a mirror of an existing pattern — deliberately left
   * for a follow-up wave. The read-door projection (`CLIENT_SAFE_SETTINGS_KEYS`
   * in workspaces.ts) already stops these keys reaching clients; this gate stops
   * arbitrary users writing them.
   */
  saveEnrichmentKeys: podAdminProcedure
    .input(
      z.object({
        apolloApiKey: z.string().optional(),
        apifyToken: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const ws = await requirePodConnectorWorkspace();

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
   *
   * Reads VAULT → `settings.messaging` → env, matching the Unipile resolver's
   * precedence. Kept in step with `saveMessagingConfig` (which now writes to the
   * vault) so a fresh save doesn't report "not configured".
   *
   * `workspaceId` is optional for backwards compatibility; when omitted this
   * keeps the legacy unordered `findFirst()` behaviour.
   */
  getMessagingConfig: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      // Same rule as getNangoConfig: a caller-supplied workspaceId must be
      // backed by membership of that workspace.
      if (input?.workspaceId) {
        const membership = await getWorkspaceMembership(
          database,
          input.workspaceId,
          ctx.userId
        );
        if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
      }
      const ws = await database.query.workspaces.findFirst({
        ...(input?.workspaceId
          ? { where: eq(workspaces.id, input.workspaceId) }
          : {}),
        columns: { settings: true, ownerId: true },
      });

      const vaultCfg = ws?.ownerId
        ? await getServiceSecret("messaging-connector", ws.ownerId)
        : null;
      const cfg = ((ws?.settings as Record<string, unknown>)?.messaging ??
        {}) as Record<string, unknown>;

      const hasDsn =
        !!vaultCfg?.dsn ||
        !!(cfg.unipileDsn as string | undefined) ||
        !!process.env.UNIPILE_DSN;
      const hasApiKey =
        !!vaultCfg?.apiKey ||
        !!(cfg.unipileApiKey as string | undefined) ||
        !!process.env.UNIPILE_API_KEY;
      const hasWebhookSecret =
        !!vaultCfg?.webhookSecret ||
        !!(cfg.unipileWebhookSecret as string | undefined) ||
        !!process.env.UNIPILE_WEBHOOK_SECRET;
      const fromEnv =
        !vaultCfg?.dsn &&
        !vaultCfg?.apiKey &&
        !cfg.unipileDsn &&
        !cfg.unipileApiKey;
      return {
        configured: hasDsn && hasApiKey,
        hasDsn,
        hasApiKey,
        hasWebhookSecret,
        fromEnv,
      };
    }),

  /**
   * Save messaging (Unipile) credentials to the VAULT (server-encrypted).
   * Pass undefined to leave a key unchanged; pass empty string to clear it.
   *
   * SECURITY: requires admin/owner of the named workspace — see
   * `requirePodConnectorWorkspace`.
   *
   * STORAGE: writes the vault secret `(workspace.ownerId, "messaging-connector")`
   * with fields `dsn` / `apiKey` / `webhookSecret` — the EXACT shape the Unipile
   * resolver already reads first (`connectors/index.ts` registerMessagingType
   * "unipile"). The legacy plaintext `settings.messaging` is left untouched (no
   * migration in this wave); the resolver still falls back to it.
   */
  saveMessagingConfig: podAdminProcedure
    .input(
      z.object({
        unipileDsn: z.string().optional(),
        unipileApiKey: z.string().optional(),
        unipileWebhookSecret: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const ws = await requirePodConnectorWorkspace();
      assertVaultWritable();
      const ownerId = vaultOwnerFor(ws);

      const existing =
        (await getServiceSecret("messaging-connector", ownerId)) ?? {};
      const merged: Record<string, string> = { ...existing };
      // Input names are Unipile-flavoured; the vault fields are the generic
      // dsn/apiKey/webhookSecret the resolver expects.
      const fieldMap = [
        ["dsn", input.unipileDsn],
        ["apiKey", input.unipileApiKey],
        ["webhookSecret", input.unipileWebhookSecret],
      ] as const;
      for (const [field, value] of fieldMap) {
        if (value === undefined) continue;
        if (value === "") delete merged[field];
        else merged[field] = value;
      }

      await upsertServiceSecret(
        "messaging-connector",
        ownerId,
        "Messaging (Unipile)",
        merged
      );

      return { success: true };
    }),

  /**
   * Probe for sibling services on the same parent domain as PUBLIC_URL.
   * e.g. pod at https://pod.team.acme.xyz → checks https://nango.team.acme.xyz
   * No user-supplied URLs — derived from the pod's own PUBLIC_URL env var only.
   */
  autodiscover: protectedProcedure.query(async () => {
    const publicUrl = process.env.PUBLIC_URL?.trim();
    // "Configured" here means a LOCAL Nango key — a CP-brokered pod has none.
    const resolvedBroker = await resolveBroker("nango");
    const localNango =
      resolvedBroker.ok && resolvedBroker.source !== "control-plane"
        ? true
        : null;

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
   *
   * Reads VAULT → env → `settings.nango`, the same precedence as
   * `resolveNangoConnector()`. Keeping this in step with the resolver is what
   * stops the "saved but not configured" ghost: `saveNangoConfig` now writes to
   * the vault, so a settings-only status check would report "not configured"
   * immediately after a successful save.
   *
   * `workspaceId` is optional for backwards compatibility with existing callers;
   * when omitted this keeps the legacy unordered `findFirst()` behaviour. Pass
   * it to get a status that matches the workspace you saved to.
   */
  getNangoConfig: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const database = await getDb();
      // A caller-supplied workspaceId is a lens, never a grant: require
      // membership of THAT workspace before reporting its connector status
      // (host / connectUrl / fromEnv is infrastructure detail).
      if (input?.workspaceId) {
        const membership = await getWorkspaceMembership(
          database,
          input.workspaceId,
          ctx.userId
        );
        if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
      }
      const ws = await database.query.workspaces.findFirst({
        ...(input?.workspaceId
          ? { where: eq(workspaces.id, input.workspaceId) }
          : {}),
        columns: { settings: true, ownerId: true },
      });

      const vaultCfg = ws?.ownerId
        ? await getServiceSecret("nango-connector", ws.ownerId)
        : null;
      const cfg = ((ws?.settings as Record<string, unknown>)?.nango ??
        {}) as Record<string, unknown>;

      const hasSecretKey =
        !!vaultCfg?.secretKey ||
        !!process.env.NANGO_SECRET_KEY ||
        !!(cfg.secretKey as string | undefined);
      const fromEnv =
        !vaultCfg?.secretKey &&
        !cfg.secretKey &&
        !!process.env.NANGO_SECRET_KEY;
      return {
        configured: hasSecretKey,
        hasSecretKey,
        host:
          vaultCfg?.host ??
          process.env.NANGO_HOST ??
          (cfg.host as string | undefined) ??
          null,
        connectUrl:
          vaultCfg?.connectUrl ??
          process.env.NANGO_CONNECT_URL ??
          (cfg.connectUrl as string | undefined) ??
          null,
        fromEnv,
      };
    }),

  /**
   * Save self-hosted Nango credentials to the VAULT (server-encrypted).
   * Pass undefined to leave a key unchanged; pass empty string to clear it.
   *
   * SECURITY: requires admin/owner of the named workspace. Previously this was
   * an ungated `protectedProcedure` writing to an arbitrary workspace picked by
   * an unordered `findFirst()` — see `resolvePodConnectorWorkspace`.
   *
   * STORAGE: writes to the vault under `(workspace.ownerId, "nango-connector")`,
   * NOT into the plaintext `settings.nango` JSONB blob. Existing `settings.nango`
   * values are deliberately left in place (no migration in this wave) — the
   * resolver still falls back to them, so live/self-hosted pods keep working.
   */
  saveNangoConfig: podAdminProcedure
    .input(
      z.object({
        secretKey: z.string().optional(),
        host: z.string().optional(),
        connectUrl: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      refuseOnBrokeredPod();
      const ws = await requirePodConnectorWorkspace();
      assertVaultWritable();
      const ownerId = vaultOwnerFor(ws);

      // Merge over what the vault already holds, so an omitted field is
      // "leave unchanged" and an empty string clears it — same contract as before.
      const existing =
        (await getServiceSecret("nango-connector", ownerId)) ?? {};
      const merged: Record<string, string> = { ...existing };
      for (const key of ["secretKey", "host", "connectUrl"] as const) {
        const value = input[key];
        if (value === undefined) continue;
        if (value === "") delete merged[key];
        else merged[key] = value;
      }

      await upsertServiceSecret(
        "nango-connector",
        ownerId,
        "Nango (self-hosted)",
        merged
      );

      // Bust the local nango cache so next call re-resolves
      cpSettingsCache = null;

      return { success: true };
    }),

  /**
   * Migrate the pod's `NANGO_*` env credential into the vault (idempotent).
   *
   * The path off the deprecated env tier: copies the existing env key into the
   * vault so it hot-reloads and the `.env` value can be removed on the next
   * deploy without stranding the pod. No-op when the vault already holds a key
   * or env supplies none — safe to run any number of times.
   */
  migrateNangoToVault: podAdminProcedure.mutation(async () => {
    // No cache bust needed: the Nango credential is resolved fresh from the
    // vault on every call (`resolveNangoConnectorResult`), so the freshly-
    // vaulted key wins on the very next resolve.
    return migrateNangoEnvToVault();
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
      const resolved = await resolveBroker("nango");
      if (!resolved.ok) {
        const notConfigured = resolved.reason === "not-configured";
        return {
          configured: !notConfigured,
          reachable: false,
          authenticated: false,
          error: notConfigured
            ? "No connection broker configured"
            : `${resolved.reason}: ${resolved.error}`,
        };
      }
      const result = await resolved.broker.probe();
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
   * Sync status per connection × kind, from the ONE sync door.
   *
   * Replaces the old read off `entity_external_links`, which matched the user by
   * a `{userId}:{podId}:{provider}` connection-id prefix that Connect-flow
   * connections (Nango-generated ids) never carry — so it was always empty.
   * `lastSyncedAt` / `entityCount` are kept for existing connector cards.
   */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    // Scoped to the caller's OWN connections inside the door: a per-connection
    // row carries another member's error / proposal / counts.
    const rows = await getConnectionSyncStatus({ userId: ctx.userId });
    return rows.map((r) => ({
      ...r,
      lastSyncedAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
      entityCount: r.counts ? r.counts.created + r.counts.merged : 0,
    }));
  }),

  /**
   * "Keep syncing automatically" for one of the caller's connections
   * (`connectionId` = the registry row id). On mints the connection's `auto`
   * rule from its approved first import; off revokes it. NOT_FOUND for another
   * user's or a deleted row; PRECONDITION_FAILED before any import was approved.
   */
  setKeepSyncing: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const outcome = await setConnectionKeepSyncing({
        userId: ctx.userId,
        connectionId: input.connectionId,
        enabled: input.enabled,
      });
      if (!outcome.ok) {
        throw new TRPCError({
          code:
            outcome.reason === "not_found"
              ? "NOT_FOUND"
              : "PRECONDITION_FAILED",
          message: outcome.error,
        });
      }
      return {
        enabled: outcome.enabled,
        ...(outcome.ruleId ? { ruleId: outcome.ruleId } : {}),
      };
    }),

  /**
   * "Sync now" for the caller's own connections. `connectionId` is the registry
   * row id (the id `syncStatus` rows carry); with only `provider`, every one of
   * the caller's connections for it. Another user's or a deleted row is
   * NOT_FOUND. A queue fault surfaces as an error, never as `enqueued`.
   */
  syncNow: protectedProcedure
    .input(
      z
        .object({
          connectionId: z.string().min(1).optional(),
          provider: z.string().min(1).optional(),
        })
        .refine((v) => !!v.connectionId || !!v.provider, {
          message: "connectionId or provider is required",
        })
    )
    .mutation(async ({ ctx, input }) => {
      const outcome = await enqueueManualConnectionSync({
        userId: ctx.userId,
        connectionId: input.connectionId,
        provider: input.provider,
      });
      if (!outcome.ok) {
        throw new TRPCError({ code: "NOT_FOUND", message: outcome.error });
      }
      return { enqueued: true as const, count: outcome.count };
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
   * Pod Admin: list ALL connections on this pod.
   *
   * The connection registry is the source: one `secrets` pointer row per broker
   * connection (`accountHint` = the broker's connection id). Sync state comes
   * from the ONE sync door. `connectionId` is the BROKER's connection id — the
   * same meaning it has in `connectors.connections` / `providers` (and the meaning this
   * procedure has always had). `registryConnectionId` is the registry row id, the
   * identity the sync door and connection governance rules key on.
   * `accountEmail` is not stored on the pod — returned `null`.
   */
  allConnections: podAdminProcedure.query(async () => {
    const registry = await db
      .select({
        id: secrets.id,
        capabilityId: secrets.capabilityId,
        accountHint: secrets.accountHint,
        workspaceId: secrets.workspaceId,
        connectionState: secrets.connectionState,
        createdAt: secrets.createdAt,
      })
      .from(secrets)
      .where(
        and(
          isNotNull(secrets.capabilityId),
          isNotNull(secrets.accountHint),
          isNull(secrets.deletedAt)
        )
      );
    // sync-status: pod-admin view — every member's rows, behind podAdminProcedure.
    const statuses = await getConnectionSyncStatus({});

    const providerByCapability = new Map<string, string | null>();
    for (const capabilityId of new Set(
      registry.map((r) => r.capabilityId).filter((c): c is string => !!c)
    )) {
      const keys = await resolveCapabilityNangoProviderKeys(capabilityId);
      providerByCapability.set(capabilityId, keys[0] ?? null);
    }

    const workspaceIds = [
      ...new Set(
        registry.map((r) => r.workspaceId).filter((w): w is string => !!w)
      ),
    ];
    const workspaceNames = new Map<string, string>();
    for (const workspaceId of workspaceIds) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { name: true },
      });
      if (ws) workspaceNames.set(workspaceId, ws.name);
    }

    return registry.map((r) => {
      const runs = statuses.filter((s) => s.connectionId === r.id);
      const lastRunAt = runs
        .map((s) => s.lastRunAt)
        .filter((t): t is string => !!t)
        .sort()
        .pop();
      const status =
        r.connectionState === "needs_reauth"
          ? "needs_reauth"
          : runs.some((s) => s.phase === "failed")
            ? "error"
            : "active";
      return {
        connectionId: r.accountHint!,
        registryConnectionId: r.id,
        providerId:
          runs[0]?.provider ??
          (r.capabilityId ? providerByCapability.get(r.capabilityId) : null) ??
          null,
        workspaceId: r.workspaceId ?? null,
        workspaceName: r.workspaceId
          ? (workspaceNames.get(r.workspaceId) ?? null)
          : null,
        accountEmail: null,
        status,
        lastSyncedAt: lastRunAt ? new Date(lastRunAt) : null,
        createdAt: r.createdAt,
      };
    });
  }),
});
