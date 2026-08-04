import { syncConnectorRegistry } from "./SyncConnector.js";
import { enrichmentProviderRegistry } from "./EnrichmentProvider.js";
import { NangoConnector } from "./NangoConnector.js";
import { ApifyProvider } from "./ApifyProvider.js";
import { ApolloProvider } from "./ApolloProvider.js";
import { UnipileConnector } from "./UnipileConnector.js";
import { StalwartConnector } from "./StalwartConnector.js";
import { DiscordConnector } from "./DiscordConnector.js";
import { ProtonConnector } from "./ProtonConnector.js";
import type { MessagingConnector } from "./MessagingConnector.js";
import {
  connectorRegistry,
  type BaseConnector,
  type ConnectorKind,
} from "./ConnectorRegistry.js";
import {
  db,
  getServiceSecret,
  getServiceSecretResult,
  upsertServiceSecret,
  isServerVaultAvailable,
  getDb,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const connectorsLogger = createLogger({ module: "connectors" });

// Warn AT MOST once per process per deprecated source — `resolveNangoConnector`
// is on a hot path, so an unthrottled warn would flood the log.
const warnedNangoSources = new Set<string>();

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

registerMessagingType("proton", async () => {
  // Proton is outbound-only here. The backend is Proton-AGNOSTIC — this connector
  // never calls Proton; `sendMessage` reads the reply envelope from the DB and
  // enqueues a `channel_egress` intent the standalone Proton Bridge delivers. No
  // credential is resolved here (the bridge holds it), so it is always available.
  return new ProtonConnector();
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

/**
 * Which tier configured the returned connector. Surfaced by `status`/`diagnose`
 * so an operator can see WHERE the key came from — the vault tier is the target
 * state; `env` and `legacy` are the tiers being retired.
 */
export type NangoConfigSource = "vault" | "env" | "legacy-settings";

/**
 * Outcome of resolving the pod's Nango broker credential.
 *
 * `not-configured` is the only NORMAL failure — it means exactly "no Nango on
 * this pod", which is a legitimate state (connectors are optional). The rest are
 * FAULTS: the credential probably exists and we could not read it. They are kept
 * distinct because they need opposite remedies — `vault-unreadable` is fixed by
 * restoring VAULT_SERVER_KEY, and telling that operator to "reconnect Nango"
 * writes a second row that is equally unreadable.
 */
export type NangoResolveResult =
  | { ok: true; connector: NangoConnector; source: NangoConfigSource }
  | {
      ok: false;
      reason: "not-configured" | "vault-unreadable" | "db-unavailable";
      error: string;
    };

/**
 * Resolve the pod's Nango connector, distinguishing "not configured" from
 * "configured but unreadable". Never throws.
 *
 * Precedence — VAULT → env → `workspace.settings.nango`:
 *   1. Vault (server-encrypted, serviceId='nango-connector', keyed by the
 *      oldest workspace's ownerId) — where `saveNangoConfig` writes. Hot: no
 *      pod restart needed, this is read fresh on every call.
 *   2. NANGO_* env vars. BEING RETIRED — requires a redeploy to change, which is
 *      the whole reason a key edit needs a container restart today.
 *   3. `workspace.settings.nango` — LEGACY PLAINTEXT. Kept deliberately: live
 *      self-hosted pods still depend on it. Do NOT remove without migrating
 *      those values into the vault first.
 *
 * NOTE on ordering: a vault FAULT does not fall through to env. Falling through
 * is what made a broken vault invisible — the pod kept working off env and
 * nobody learned the vault was unreadable until env was gone.
 */
export async function resolveNangoConnectorResult(): Promise<NangoResolveResult> {
  let ws: Awaited<ReturnType<typeof resolvePodConnectorWorkspace>>;
  try {
    ws = await resolvePodConnectorWorkspace();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // DB not ready. Env can still serve (boot ordering), but say so rather than
    // reporting the pod as unconfigured.
    if (nangoConnector.isConfigured()) {
      return { ok: true, connector: nangoConnector, source: "env" };
    }
    return { ok: false, reason: "db-unavailable", error };
  }

  // 1. Vault first.
  if (ws?.ownerId) {
    const vault = await getServiceSecretResult("nango-connector", ws.ownerId);
    if (vault.ok && vault.config.secretKey) {
      return {
        ok: true,
        connector: new NangoConnector({
          secretKey: vault.config.secretKey,
          host: vault.config.host,
          connectUrl: vault.config.connectUrl,
        }),
        source: "vault",
      };
    }
    // A vault FAULT is terminal — see the ordering note above. `absent` is not a
    // fault: it just means this pod configures Nango some other way (or not).
    if (!vault.ok && vault.reason !== "absent") {
      return { ok: false, reason: "vault-unreadable", error: vault.error };
    }
  }

  // 2. Env (shared instance). DEPRECATED tier — see warnDeprecatedNangoSource.
  if (nangoConnector.isConfigured()) {
    warnDeprecatedNangoSource("env");
    return { ok: true, connector: nangoConnector, source: "env" };
  }

  // 3. Legacy plaintext settings fallback. DEPRECATED tier.
  const cfg = ((ws?.settings as Record<string, unknown>)?.nango ?? {}) as {
    secretKey?: string;
    host?: string;
    connectUrl?: string;
  };
  if (cfg.secretKey) {
    warnDeprecatedNangoSource("legacy-settings");
    return {
      ok: true,
      connector: new NangoConnector({
        secretKey: cfg.secretKey,
        host: cfg.host,
        connectUrl: cfg.connectUrl,
      }),
      source: "legacy-settings",
    };
  }

  return {
    ok: false,
    reason: "not-configured",
    error: "No Nango credential is configured on this pod",
  };
}

/**
 * Compat wrapper over {@link resolveNangoConnectorResult} — connector, or null
 * for EVERY failure.
 *
 * Prefer `resolveNangoConnectorResult` on any path that reports state to a human
 * or an agent: this shape cannot tell "no Nango here" from "Nango is configured
 * and broken", and reporting the second as the first is the bug this wave exists
 * to kill.
 */
export async function resolveNangoConnector(): Promise<NangoConnector | null> {
  const result = await resolveNangoConnectorResult();
  return result.ok ? result.connector : null;
}

/**
 * Warn (once per process) that Nango is being served from a DEPRECATED tier.
 *
 * The target state is the vault tier: hot-reloaded, no `.env`, no pod restart to
 * rotate the key. `env` requires a redeploy to change; `legacy-settings` is
 * plaintext in `workspaces.settings`. Both are slated for removal — this warning
 * is the migration signal, and `migrateNangoEnvToVault()` is the migration path.
 */
function warnDeprecatedNangoSource(source: "env" | "legacy-settings"): void {
  if (warnedNangoSources.has(source)) return;
  warnedNangoSources.add(source);
  connectorsLogger.warn(
    { source },
    source === "env"
      ? "Nango is configured via the NANGO_* ENV tier (deprecated). Migrate the key into the vault (run migrateNangoEnvToVault or re-save it in Settings → Connectors) so it hot-reloads without a pod restart."
      : "Nango is configured via the LEGACY plaintext workspaces.settings.nango tier (deprecated). Migrate it into the vault."
  );
}

/**
 * One-shot, idempotent migration of the pod's `NANGO_*` env credential into the
 * vault (serviceId `nango-connector`, owned by the pod-connector workspace).
 *
 * Safe to call repeatedly and safe to wire into startup: it is a NO-OP unless
 * (a) the vault has no `nango-connector` secret yet AND (b) env supplies one.
 * It never overwrites a vault key, and never touches `.env`. After it runs, the
 * vault tier wins in `resolveNangoConnectorResult` and the env var can be
 * removed on the next deploy without stranding the pod.
 *
 * Returns what happened, so a CLI/startup caller can report it.
 */
export async function migrateNangoEnvToVault(): Promise<{
  migrated: boolean;
  reason:
    | "migrated"
    | "vault-already-set"
    | "no-env"
    | "no-owner"
    | "vault-unavailable";
}> {
  const envKey = process.env.NANGO_SECRET_KEY;
  if (!envKey) return { migrated: false, reason: "no-env" };

  // `upsertServiceSecret` → `encryptConfig` THROWS when VAULT_SERVER_KEY is
  // unset. Guard here so the migration degrades to a legible reason instead of
  // a 500 — the same read-path-legibility principle this workstream is built on.
  if (!isServerVaultAvailable()) {
    return { migrated: false, reason: "vault-unavailable" };
  }

  const ws = await resolvePodConnectorWorkspace();
  if (!ws?.ownerId) return { migrated: false, reason: "no-owner" };

  const existing = await getServiceSecretResult("nango-connector", ws.ownerId);
  if (existing.ok && existing.config.secretKey) {
    return { migrated: false, reason: "vault-already-set" };
  }

  await upsertServiceSecret("nango-connector", ws.ownerId, "Nango connector", {
    secretKey: envKey,
    ...(process.env.NANGO_HOST ? { host: process.env.NANGO_HOST } : {}),
    ...(process.env.NANGO_SERVER_URL
      ? { connectUrl: process.env.NANGO_SERVER_URL }
      : {}),
  });
  connectorsLogger.info(
    { ownerId: ws.ownerId },
    "Migrated NANGO_* env credential into the vault (nango-connector). The env var can now be removed on the next deploy."
  );
  return { migrated: true, reason: "migrated" };
}

/**
 * Returns a configured MessagingConnector resolved through the unified
 * connector registry.
 *
 * The `provider` selects the registered messaging TYPE descriptor:
 *   - "stalwart" → self-hosted Stalwart/JMAP (vault `stalwart-connector`)
 *   - "discord"  → agnostic egress: enqueues to the channel_egress outbox; the
 *                  Discord bridge holds the token and delivers (no token here)
 *   - "proton"   → agnostic egress: reads the reply envelope from the DB, enqueues
 *                  to the channel_egress outbox; the Proton bridge delivers
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
      MessagingConnectorDescriptor | undefined;
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
export { ProtonConnector } from "./ProtonConnector.js";
export { NangoConnector } from "./NangoConnector.js";
