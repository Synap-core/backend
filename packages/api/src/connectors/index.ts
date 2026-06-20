import { syncConnectorRegistry } from "./SyncConnector.js";
import { enrichmentProviderRegistry } from "./EnrichmentProvider.js";
import { NangoConnector } from "./NangoConnector.js";
import { ApifyProvider } from "./ApifyProvider.js";
import { ApolloProvider } from "./ApolloProvider.js";
import { UnipileConnector } from "./UnipileConnector.js";
import { StalwartConnector } from "./StalwartConnector.js";
import { DiscordConnector } from "./DiscordConnector.js";
import type { MessagingConnector } from "./MessagingConnector.js";
import { db, getServiceSecret } from "@synap/database";

syncConnectorRegistry.register(new NangoConnector());
enrichmentProviderRegistry.register(new ApifyProvider());
enrichmentProviderRegistry.register(new ApolloProvider());

/**
 * Returns a configured MessagingConnector.
 *
 * When `provider === "stalwart"`, resolves the self-hosted Stalwart/JMAP
 * connector from the `stalwart-connector` vault secret ({ jmapUrl, bearerToken,
 * accountEmail }). For every other provider (the default) it resolves the
 * Unipile connector, reading credentials from:
 *   1. Vault (server-encrypted secret with serviceId='messaging-connector')
 *   2. workspace.settings.messaging (set via Settings UI)
 *   3. UNIPILE_* env vars (server-managed deployments)
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

    if (provider === "stalwart") {
      if (!ws?.ownerId) return null;
      const cfg = await getServiceSecret("stalwart-connector", ws.ownerId);
      if (!cfg?.jmapUrl || !cfg?.bearerToken) return null;
      return new StalwartConnector({
        jmapUrl: cfg.jmapUrl,
        bearerToken: cfg.bearerToken,
        accountEmail: cfg.accountEmail,
      });
    }

    if (provider === "discord") {
      // Discord is outbound-only and server-managed: the bot token lives in
      // DISCORD_BOT_TOKEN. Return null when unconfigured so callers no-op.
      const discord = new DiscordConnector();
      return discord.isConfigured() ? discord : null;
    }

    if (ws?.ownerId) {
      const vaultCfg = await getServiceSecret(
        "messaging-connector",
        ws.ownerId
      );
      if (vaultCfg?.dsn && vaultCfg?.apiKey) {
        return new UnipileConnector({
          dsn: vaultCfg.dsn,
          apiKey: vaultCfg.apiKey,
          webhookSecret: vaultCfg.webhookSecret,
        });
      }
    }

    // Fall back to workspace.settings.messaging
    const cfg = ((ws?.settings as Record<string, unknown>)?.messaging ??
      {}) as Record<string, unknown>;
    const dsn =
      (cfg.unipileDsn as string | undefined) || process.env.UNIPILE_DSN;
    const apiKey =
      (cfg.unipileApiKey as string | undefined) || process.env.UNIPILE_API_KEY;
    const webhookSecret =
      (cfg.unipileWebhookSecret as string | undefined) ||
      process.env.UNIPILE_WEBHOOK_SECRET;
    if (!dsn || !apiKey) return null;
    return new UnipileConnector({ dsn, apiKey, webhookSecret });
  } catch {
    // DB not ready yet — fall back to env
    const connector = new UnipileConnector();
    return connector.isConfigured() ? connector : null;
  }
}

export { syncConnectorRegistry, enrichmentProviderRegistry };

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
