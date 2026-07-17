import { syncConnectorRegistry } from "./SyncConnector.js";
import { enrichmentProviderRegistry } from "./EnrichmentProvider.js";
import { NangoConnector } from "./NangoConnector.js";
import { ApifyProvider } from "./ApifyProvider.js";
import { ApolloProvider } from "./ApolloProvider.js";
import { UnipileConnector } from "./UnipileConnector.js";
import { StalwartConnector } from "./StalwartConnector.js";
import { DiscordConnector } from "./DiscordConnector.js";
import type { MessagingConnector } from "./MessagingConnector.js";
import {
  connectorRegistry,
  type BaseConnector,
  type ConnectorKind,
} from "./ConnectorRegistry.js";
import { db, getServiceSecret, getDb } from "@synap/database";

// ── ONE registry: all three families mirror into the unified
//    `connectorRegistry`. ─────────────────────────────────────────────────────
//
// Sync + enrichment keep their family-specific registries
// (`syncConnectorRegistry` / `enrichmentProviderRegistry`) as THIN SHIMS so
// their existing callers are unchanged — but each registered instance is ALSO
// mirrored into the unified registry via the `asBaseConnector` facade so
// `forCapability(...)` sees every connector regardless of family. Messaging is
// per-call (DB/vault/env), so it registers RESOLVER DESCRIPTORS (below) rather
// than a shared instance.

/**
 * Wrap a family-specific connector (keyed by `name`) so it satisfies
 * `BaseConnector` (keyed by `type` + `kind`) for the unified registry, while
 * preserving every original method so capability guards (`isReadable`, etc.)
 * still detect the underlying surface. The original instance is the prototype,
 * so all methods stay bound and present.
 */
function asBaseConnector(
  instance: object,
  type: string,
  kind: ConnectorKind
): BaseConnector {
  const facade = Object.create(instance) as BaseConnector & {
    type: string;
    kind: ConnectorKind;
  };
  facade.type = type;
  facade.kind = kind;
  return facade;
}

// Sync: Nango. Register into the sync shim AND mirror into the unified registry.
const nangoConnector = new NangoConnector();
syncConnectorRegistry.register(nangoConnector);
connectorRegistry.register(asBaseConnector(nangoConnector, "nango", "sync"));

// Enrichment: Apify + Apollo. Same dual-register.
const apifyProvider = new ApifyProvider();
const apolloProvider = new ApolloProvider();
enrichmentProviderRegistry.register(apifyProvider);
enrichmentProviderRegistry.register(apolloProvider);
connectorRegistry.register(
  asBaseConnector(apifyProvider, "apify", "enrichment")
);
connectorRegistry.register(
  asBaseConnector(apolloProvider, "apollo", "enrichment")
);

// ── Messaging connectors ──────────────────────────────────────────────────
//
// Unlike sync/enrichment connectors (one shared instance), a MessagingConnector
// is resolved PER CALL from DB + vault + env. So instead of a hardcoded
// `if (provider === ...)` ladder, each messaging TYPE registers ONE descriptor
// in the unified registry describing how to resolve a configured instance.
// `getMessagingConnector(provider)` then becomes a registry lookup over those
// descriptors — agnostic, with no provider branch in the lookup itself.

/** Context passed to a messaging-type resolver. */
interface MessagingResolveContext {
  ownerId?: string;
  settings?: Record<string, unknown>;
}

/**
 * A messaging-type descriptor registered in the unified registry. It is a
 * `BaseConnector` (so it lives in the same store, `kind: "messaging"`) plus a
 * `resolve()` that returns a configured `MessagingConnector` or null.
 */
interface MessagingConnectorDescriptor extends BaseConnector {
  readonly kind: "messaging";
  resolve(ctx: MessagingResolveContext): Promise<MessagingConnector | null>;
}

/** Build + register a messaging descriptor under its `type` key. */
function registerMessagingType(
  type: string,
  resolve: (ctx: MessagingResolveContext) => Promise<MessagingConnector | null>
): void {
  const descriptor: MessagingConnectorDescriptor = {
    type,
    kind: "messaging",
    // Configuration is per-call (DB/vault/env), so the descriptor itself is
    // always "available"; `resolve()` returns null when truly unconfigured.
    isConfigured: () => true,
    resolve,
  };
  connectorRegistry.register(descriptor);
}

// Default messaging type used when a caller passes no provider — preserves the
// long-standing "no-arg call → Unipile" behaviour.
const DEFAULT_MESSAGING_TYPE = "unipile";

registerMessagingType("stalwart", async ({ ownerId }) => {
  if (!ownerId) return null;
  const cfg = await getServiceSecret("stalwart-connector", ownerId);
  if (!cfg?.jmapUrl || !cfg?.bearerToken) return null;
  return new StalwartConnector({
    jmapUrl: cfg.jmapUrl,
    bearerToken: cfg.bearerToken,
    accountEmail: cfg.accountEmail,
  });
});

registerMessagingType("discord", async () => {
  // Discord is outbound-only. The backend is Discord-AGNOSTIC — this connector
  // never calls discord.com; `sendMessage` enqueues a `channel_egress` intent the
  // bridge delivers. No token is resolved here (the bridge holds it), so the
  // connector is always available.
  return new DiscordConnector();
});

registerMessagingType("unipile", async ({ ownerId, settings }) => {
  if (ownerId) {
    const vaultCfg = await getServiceSecret("messaging-connector", ownerId);
    if (vaultCfg?.dsn && vaultCfg?.apiKey) {
      return new UnipileConnector({
        dsn: vaultCfg.dsn,
        apiKey: vaultCfg.apiKey,
        webhookSecret: vaultCfg.webhookSecret,
      });
    }
  }
  // Fall back to workspace.settings.messaging
  const cfg = ((settings as Record<string, unknown>)?.messaging ??
    {}) as Record<string, unknown>;
  const dsn = (cfg.unipileDsn as string | undefined) || process.env.UNIPILE_DSN;
  const apiKey =
    (cfg.unipileApiKey as string | undefined) || process.env.UNIPILE_API_KEY;
  const webhookSecret =
    (cfg.unipileWebhookSecret as string | undefined) ||
    process.env.UNIPILE_WEBHOOK_SECRET;
  if (!dsn || !apiKey) return null;
  return new UnipileConnector({ dsn, apiKey, webhookSecret });
});

// ── ONE Nango resolver ──────────────────────────────────────────────────────
//
// Nango has the SAME per-call config concern as messaging (env first, then
// `workspace.settings.nango` fallback). This is the SINGLE source for a
// configured Nango connector: both `syncConnectorRegistry.get("nango")` callers
// (which get the env-only shared instance) and the former `getLocalNango()` /
// `new NangoConnector()` sites now route through here, killing the dual path.

/**
 * Resolve a configured `NangoConnector`. Returns null when nothing configures a
 * secret key (pod must use CP-managed Nango).
 *
 * Precedence — VAULT → env → `workspace.settings.nango`, mirroring the Unipile
 * messaging resolver above:
 *   1. Vault (server-encrypted, serviceId='nango-connector', keyed by the
 *      workspace ownerId) — where `saveNangoConfig` now writes.
 *   2. NANGO_* env vars (the registry's shared instance is env-configured).
 *   3. `workspace.settings.nango` — LEGACY plaintext. Kept deliberately: no
 *      migration in this wave, and live/self-hosted pods still depend on it.
 *      Do NOT remove without migrating those values into the vault first.
 */
/**
 * The ONE workspace whose owner pod-infra connector credentials are vaulted
 * under, and whose legacy `settings` are read.
 *
 * These credentials are POD-WIDE: one Nango key serves every workspace. An
 * unordered `findFirst()` lets the writer and this resolver land on different
 * rows — which both produces "saved but not configured" and, because owning ANY
 * workspace cleared the write gate, let a self-created workspace's owner become
 * the pod's connector config. Pinning to the oldest workspace makes writer and
 * reader resolve the same identity by construction.
 */
export async function resolvePodConnectorWorkspace(): Promise<{
  id: string;
  ownerId: string | null;
  settings: unknown;
} | null> {
  const database = await getDb();
  const ws = await database.query.workspaces.findFirst({
    orderBy: (w, { asc }) => [asc(w.createdAt)],
    columns: { id: true, settings: true, ownerId: true },
  });
  return ws ?? null;
}

export async function resolveNangoConnector(): Promise<NangoConnector | null> {
  try {
    const ws = await resolvePodConnectorWorkspace();

    // 1. Vault first.
    if (ws?.ownerId) {
      const vaultCfg = await getServiceSecret("nango-connector", ws.ownerId);
      if (vaultCfg?.secretKey) {
        return new NangoConnector({
          secretKey: vaultCfg.secretKey,
          host: vaultCfg.host,
          connectUrl: vaultCfg.connectUrl,
        });
      }
    }

    // 2. Env (shared instance).
    if (nangoConnector.isConfigured()) return nangoConnector;

    // 3. Legacy plaintext settings fallback.
    const cfg = ((ws?.settings as Record<string, unknown>)?.nango ?? {}) as {
      secretKey?: string;
      host?: string;
      connectUrl?: string;
    };
    if (cfg.secretKey) {
      return new NangoConnector({
        secretKey: cfg.secretKey,
        host: cfg.host,
        connectUrl: cfg.connectUrl,
      });
    }
  } catch {
    // DB not ready — fall back to the env-configured shared instance.
    if (nangoConnector.isConfigured()) return nangoConnector;
  }
  return null;
}

/**
 * Returns a configured MessagingConnector resolved through the unified
 * connector registry.
 *
 * The `provider` selects the registered messaging TYPE descriptor:
 *   - "stalwart" → self-hosted Stalwart/JMAP (vault `stalwart-connector`)
 *   - "discord"  → agnostic egress: enqueues to the channel_egress outbox; the
 *                  Discord bridge holds the token and delivers (no token here)
 *   - anything else / undefined → Unipile, reading credentials from:
 *       1. Vault (server-encrypted secret with serviceId='messaging-connector')
 *       2. workspace.settings.messaging (set via Settings UI)
 *       3. UNIPILE_* env vars (server-managed deployments)
 * Returns null when no source is configured.
 *
 * The param is optional so existing no-arg callers keep Unipile behaviour
 * unchanged; the send path passes the channel's provider to route correctly.
 */
export async function getMessagingConnector(
  provider?: string
): Promise<MessagingConnector | null> {
  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true, ownerId: true },
    });

    // Registry lookup replaces the old if-ladder: pick the descriptor for the
    // requested type, falling back to the default (Unipile) when the provider
    // is unset or not a registered messaging type.
    const type =
      provider && connectorRegistry.get(provider)?.kind === "messaging"
        ? provider
        : DEFAULT_MESSAGING_TYPE;
    const descriptor = connectorRegistry.get(type) as
      | MessagingConnectorDescriptor
      | undefined;
    if (!descriptor) return null;

    return await descriptor.resolve({
      ownerId: ws?.ownerId ?? undefined,
      settings: (ws?.settings as Record<string, unknown>) ?? undefined,
    });
  } catch {
    // DB not ready yet — fall back to env-only Unipile.
    const connector = new UnipileConnector();
    return connector.isConfigured() ? connector : null;
  }
}

export { syncConnectorRegistry, enrichmentProviderRegistry };
export {
  connectorRegistry,
  isCredentialed,
  isReadable,
  isPushable,
  isSensing,
} from "./ConnectorRegistry.js";
export type {
  BaseConnector,
  ConnectorKind,
  ConnectorRegistry,
  Credentialed,
  Readable,
  Pushable,
  Sensing,
} from "./ConnectorRegistry.js";

export type {
  SyncConnector,
  SyncConnectorRecord,
  SyncConnectorSession,
  SyncConnectorConnection,
} from "./SyncConnector.js";

export type {
  EnrichmentProvider,
  EnrichmentInput,
  EnrichmentResult,
  EnrichmentCapability,
} from "./EnrichmentProvider.js";

export type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";
export { UnipileConnector } from "./UnipileConnector.js";
export { StalwartConnector } from "./StalwartConnector.js";
export type { StalwartConnectorConfig } from "./StalwartConnector.js";
export { DiscordConnector } from "./DiscordConnector.js";
export { NangoConnector } from "./NangoConnector.js";
