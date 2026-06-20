import { syncConnectorRegistry } from "./SyncConnector.js";
import { enrichmentProviderRegistry } from "./EnrichmentProvider.js";
import { NangoConnector } from "./NangoConnector.js";
import { ApifyProvider } from "./ApifyProvider.js";
import { ApolloProvider } from "./ApolloProvider.js";
import { UnipileConnector } from "./UnipileConnector.js";
import { StalwartConnector } from "./StalwartConnector.js";
import { DiscordConnector } from "./DiscordConnector.js";
import type { MessagingConnector } from "./MessagingConnector.js";
import { connectorRegistry, type BaseConnector } from "./ConnectorRegistry.js";
import { db, getServiceSecret } from "@synap/database";

// ── Sync + enrichment connectors register through their facades, which also
//    mirror into the single unified `connectorRegistry`. ─────────────────────
syncConnectorRegistry.register(new NangoConnector());
enrichmentProviderRegistry.register(new ApifyProvider());
enrichmentProviderRegistry.register(new ApolloProvider());

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
  // Discord is outbound-only and server-managed: the bot token lives in
  // DISCORD_BOT_TOKEN. Return null when unconfigured so callers no-op.
  const discord = new DiscordConnector();
  return discord.isConfigured() ? discord : null;
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

/**
 * Returns a configured MessagingConnector resolved through the unified
 * connector registry.
 *
 * The `provider` selects the registered messaging TYPE descriptor:
 *   - "stalwart" → self-hosted Stalwart/JMAP (vault `stalwart-connector`)
 *   - "discord"  → server-managed Discord bot (DISCORD_BOT_TOKEN)
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
export { connectorRegistry } from "./ConnectorRegistry.js";
export type {
  BaseConnector,
  ConnectorKind,
  ConnectorRegistry,
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
