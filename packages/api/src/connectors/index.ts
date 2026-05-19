import { syncConnectorRegistry } from "./SyncConnector.js";
import { enrichmentProviderRegistry } from "./EnrichmentProvider.js";
import { NangoConnector } from "./NangoConnector.js";
import { ApifyProvider } from "./ApifyProvider.js";
import { ApolloProvider } from "./ApolloProvider.js";
import { UnipileConnector } from "./UnipileConnector.js";
import type { MessagingConnector } from "./MessagingConnector.js";
import { db, getServiceSecret } from "@synap/database";

syncConnectorRegistry.register(new NangoConnector());
enrichmentProviderRegistry.register(new ApifyProvider());
enrichmentProviderRegistry.register(new ApolloProvider());

/**
 * Returns a configured MessagingConnector, reading credentials from:
 * 1. Vault (server-encrypted secret with serviceId='messaging-connector')
 * 2. workspace.settings.messaging (set via Settings UI)
 * 3. UNIPILE_* env vars (fallback for server-managed deployments)
 * Returns null when no source is configured.
 */
export async function getMessagingConnector(): Promise<MessagingConnector | null> {
  try {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true, ownerId: true },
    });

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
