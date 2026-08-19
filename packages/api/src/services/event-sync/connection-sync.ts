/**
 * Connection-keyed sync substrate — the ONE reusable "sync a source-provider
 * CONNECTION → sovereign Synap kind-entities" trigger.
 *
 * WHAT IT REPLACES: `runGcalImport` used to be gated on the DISCORD tool's
 * `discord.eventSync` metadata (a foreign object) and had zero workspace
 * scoping. This module re-homes the enable-gate + config onto the SOURCE
 * PROVIDER'S OWN connection (a `tools` row, e.g. `name:"google"`), under a
 * per-kind `metadata.sync` block, and adds caller/workspace scoping.
 *
 * HOW IT GENERALIZES (Gmail / Drive ride it later): the provider declares WHICH
 * Synap kinds it syncs by REGISTERING a `SyncKindHandler` (`registerSyncKind`).
 * Each handler owns its provider READ verb + its map→create→external-link
 * landing. `runConnectionSync(provider)` resolves the connection, reads the
 * per-kind sync config (template-default ⊕ user-override), and drives every
 * enabled kind's handler. Calendar is wired now (`google`/`event`); Gmail
 * (`google`/`email`) and Drive (`google`/`document`) plug in by registering
 * their own kind + mapper — NO change to this file.
 *
 * The config lives on the connection tool's `metadata.sync` (see
 * `ProviderSyncConfig`) so it is user-editable per connection, and the SHAPE is
 * keyed per Synap kind so a second kind is additive, never a reshuffle.
 */

import { createLogger } from "@synap-core/core";
import { resolveTool } from "../tools/resolve-tool.js";

const logger = createLogger({ module: "connection-sync" });

// ── Config shape (per-kind, keyed on the connection — generalizes to Gmail/Drive) ──

export type SyncScope = "recent" | "all";

/**
 * Per-kind sync config AS STORED on the provider tool's
 * `metadata.sync.kinds.<kind>`. All fields optional — a stored block is merged
 * OVER the handler's template default, so absent = "inherit the default".
 */
export interface StoredKindSyncConfig {
  enabled?: boolean;
  /** `recent` = ongoing window (fires automations); `all` = full backfill (throttled). */
  scope?: SyncScope;
  /**
   * Which sub-sources to pull for this kind — calendar ids for `event`, and (by
   * the same shape) label ids for `email` / folder ids for `document` later.
   * Empty/absent = the provider's own default sub-source.
   */
  sources?: string[];
}

/** Resolved per-kind config (template default ⊕ stored override) handed to a handler. */
export interface ResolvedKindSyncConfig {
  enabled: boolean;
  scope: SyncScope;
  sources: string[];
}

/** The `sync` block on a provider connection tool's `metadata`. */
export interface ProviderSyncConfig {
  /** Master enable for this connection's sync. */
  enabled?: boolean;
  /** Pin the sync to a specific 1-of-N connection (secrets row) for this provider. */
  connectionId?: string;
  /** Optional channel (external id) for connection-health nudges. */
  announceChannelId?: string;
  /** Per-kind overrides, keyed by Synap entity kind (e.g. `event`, `email`). */
  kinds?: Record<string, StoredKindSyncConfig>;
}

export interface ProviderToolMetadata {
  sync?: ProviderSyncConfig;
  [k: string]: unknown;
}

/**
 * The `isEnabled` predicate for `resolveTool(provider, …)` on the sync path.
 * Mirrors `isDiscordEventSyncEnabled` — the tie-break asks the question it gates
 * on (`metadata.sync.enabled`), so an unscoped (cron) resolve prefers the row
 * whose sync is actually switched on.
 */
export function isProviderSyncEnabled(metadata: unknown): boolean {
  return (metadata as { sync?: { enabled?: boolean } })?.sync?.enabled === true;
}

// ── Sync-kind registry ─────────────────────────────────────────────────────────

export interface SyncKindContext {
  /** Owning principal of the connection (the tool's `createdBy`). */
  owner: string;
  /** Effective workspace lens (null = pod-wide). */
  workspaceId: string | null;
  /** 1-of-N connection pin (secrets row), when configured. */
  connectionId?: string;
  /** Channel (external id) for connection-health nudges. */
  announceChannelId?: string;
  /** Template default ⊕ user override for THIS kind. */
  kindConfig: ResolvedKindSyncConfig;
  /**
   * True when this run is a full backfill (`scope: "all"`). The handler MUST
   * suppress the reactor-bus fan-out (`emitSideEffects`) for landed rows so
   * imported HISTORY does not replay into automations — the same throttle
   * `inbound-recorder`'s `suppressSideEffects` applies to bulk message backfill.
   */
  backfill: boolean;
  /** The provider tool row id + metadata (home of the health-notice watermark). */
  toolId: string;
  toolMetadata: Record<string, unknown>;
}

export type KindSyncResult =
  | { skipped: true; reason: string }
  | {
      processed: number;
      created: number;
      linkedExisting: number;
      failed: number;
    };

export interface SyncKindHandler {
  /** External provider this handler belongs to, e.g. `"google"`. */
  provider: string;
  /** Synap entity kind produced, e.g. `"event"`. */
  kind: string;
  /**
   * Template-default sync params — what the capability template declares as the
   * connection's out-of-the-box behavior. The stored `metadata.sync.kinds.<kind>`
   * override is merged over this per field.
   */
  defaults: ResolvedKindSyncConfig;
  run(ctx: SyncKindContext): Promise<KindSyncResult>;
}

const REGISTRY: SyncKindHandler[] = [];

/**
 * Register a provider's sync kind. Idempotent per (provider, kind) so a
 * re-import (dev HMR / repeated boot) replaces rather than duplicates.
 */
export function registerSyncKind(handler: SyncKindHandler): void {
  const idx = REGISTRY.findIndex(
    (h) => h.provider === handler.provider && h.kind === handler.kind
  );
  if (idx >= 0) REGISTRY[idx] = handler;
  else REGISTRY.push(handler);
}

export function getSyncKinds(provider: string): SyncKindHandler[] {
  return REGISTRY.filter((h) => h.provider === provider);
}

function resolveKindConfig(
  handler: SyncKindHandler,
  syncCfg: ProviderSyncConfig
): ResolvedKindSyncConfig {
  const stored = syncCfg.kinds?.[handler.kind] ?? {};
  return {
    enabled: stored.enabled ?? handler.defaults.enabled,
    scope: stored.scope ?? handler.defaults.scope,
    sources: Array.isArray(stored.sources)
      ? stored.sources
      : handler.defaults.sources,
  };
}

export interface RunConnectionSyncResult {
  skipped?: boolean;
  reason?: string;
  provider?: string;
  kinds?: Record<string, KindSyncResult>;
}

/**
 * Sync ONE source-provider connection → Synap kind-entities.
 *
 * Resolves the provider connection (workspace-scoped when a caller supplies a
 * workspace, else the unscoped cron tie-break), reads `metadata.sync`, and runs
 * every registered + enabled kind's handler. Each handler owns its read verb +
 * landing; this function only resolves config and drives the loop.
 */
export async function runConnectionSync(opts: {
  /** Provider connection tool name, e.g. `"google"`. */
  provider: string;
  /**
   * Caller's workspace. Provided (a scoped invocation) → only that workspace's
   * connection row is used. Omitted/null (a cron tick) → the unscoped tie-break.
   */
  workspaceId?: string | null;
}): Promise<RunConnectionSyncResult> {
  const tool = await resolveTool(
    opts.provider,
    isProviderSyncEnabled,
    opts.workspaceId ?? undefined
  );
  if (!tool) return { skipped: true, reason: `no_${opts.provider}_tool` };

  const metadata = (tool.metadata ?? {}) as ProviderToolMetadata;
  const syncCfg = metadata.sync;
  if (!syncCfg?.enabled) return { skipped: true, reason: "sync_disabled" };

  const owner = tool.createdBy;
  const workspaceId = tool.workspaceId ?? opts.workspaceId ?? null;

  const handlers = getSyncKinds(opts.provider);
  if (handlers.length === 0) {
    return { skipped: true, reason: "no_sync_kinds_registered" };
  }

  const kinds: Record<string, KindSyncResult> = {};
  for (const handler of handlers) {
    const kindConfig = resolveKindConfig(handler, syncCfg);
    if (!kindConfig.enabled) {
      kinds[handler.kind] = { skipped: true, reason: "kind_disabled" };
      continue;
    }
    try {
      kinds[handler.kind] = await handler.run({
        owner,
        workspaceId,
        connectionId: syncCfg.connectionId,
        announceChannelId: syncCfg.announceChannelId,
        kindConfig,
        backfill: kindConfig.scope === "all",
        toolId: tool.id,
        toolMetadata: metadata as Record<string, unknown>,
      });
    } catch (err) {
      logger.warn(
        { err, provider: opts.provider, kind: handler.kind },
        "connection-sync: kind handler failed"
      );
      kinds[handler.kind] = { skipped: true, reason: "handler_error" };
    }
  }
  return { provider: opts.provider, kinds };
}
