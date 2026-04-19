/**
 * ISourceProvider — Pluggable Feed Source Provider Interface
 *
 * A source provider fetches items from ONE kind of external source (RSS, a JSON
 * HTTP API, a CP relay, etc.) and normalizes them into a single shape
 * (`SourceItem`). Providers are stateless, pure transforms: they take a
 * resolved config (vault:// references already dereferenced to plaintext) and
 * return items.
 *
 * Design goals:
 *   - Pod-native: providers run on the Pod, no CP required
 *   - Pluggable: new providers are registered via SourceProviderRegistry,
 *     never imported directly by schedulers/executors
 *   - Cursor-aware: each provider defines its own cursor format (ETag,
 *     lastId, timestamp); cursors flow through the scheduler untouched
 *   - Testable: every provider can be asked to testConnection() without
 *     actually enqueueing an ingest run
 *
 * See packages/feed-service/src/providers/RSSDirectProvider.ts for a full
 * implementation example.
 */

import type { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Normalized Item Shape
// ────────────────────────────────────────────────────────────────────────────

/**
 * Universal item shape every provider must return.
 *
 * - `externalId` is the dedup key within a single source (RSS guid, API id,
 *   CP-relay item id). Uniqueness is per source, not global.
 * - `raw` carries provider-specific extras (enclosures, categories, mime type,
 *   etc.). Callers that want more than the core fields can type-narrow on it.
 */
export interface SourceItem {
  /** Dedup key within this source (RSS guid, API id, relay item id) */
  externalId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt: Date;
  author?: string;
  imageUrl?: string;
  /** Provider-specific extras (typed as unknown; providers may refine) */
  raw?: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Fetch Contract
// ────────────────────────────────────────────────────────────────────────────

export interface FetchParams {
  /**
   * Cursor from the previous successful fetch.
   * Provider-defined format — opaque to the scheduler.
   *   - RSS: usually an ETag or Last-Modified string
   *   - HTTP API: highest item id or timestamp
   *   - CP relay: relay-provided continuation token
   */
  sinceToken?: string;
  /** Max items this fetch may return (provider may return fewer). */
  limit?: number;
}

export interface FetchResult {
  items: SourceItem[];
  /** New cursor to persist. If omitted, scheduler keeps the old one. */
  nextToken?: string;
  /**
   * Hint to the scheduler for when to poll again.
   * Useful when a source exposes rate-limit headers or cache-control.
   */
  pollAfterSeconds?: number;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  /** Optional: number of items visible during the test probe. */
  sampleCount?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider Metadata
// ────────────────────────────────────────────────────────────────────────────

export interface SourceProviderCapabilities {
  /** True when the provider honors and returns cursors across fetches. */
  supportsCursor: boolean;
  /** True when testConnection() does more than a no-op. */
  supportsTesting: boolean;
  /** True when the provider requires credentials (API key, Bearer, etc.). */
  requiresAuth: boolean;
}

export interface SourceProviderMeta {
  /**
   * Machine-readable provider type. Must be unique across the registry.
   * Example values: 'rss-direct', 'http-api', 'cp-relay'.
   */
  type: string;
  displayName: string;
  description: string;
  capabilities: SourceProviderCapabilities;
  /**
   * Zod schema describing the shape of config this provider accepts.
   * Kept as `unknown` in the type so consumers can pass a ZodTypeAny without
   * needing to pin the generic — every provider holds its own concrete schema
   * internally.
   */
  configSchema: z.ZodTypeAny;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider Interface
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolved configuration passed to a provider at call time.
 *
 * IMPORTANT: vault:// references MUST have been resolved to plaintext before a
 * provider is invoked. Providers never call the vault resolver themselves —
 * callers (feed executors, tRPC routes, admin REST) are responsible for
 * threading userId through `resolveVaultReferences()` first.
 */
export type ResolvedConfig = Record<string, unknown>;

export interface ISourceProvider {
  readonly meta: SourceProviderMeta;

  /**
   * Fetch new items from the source.
   *
   * @throws Any error from the underlying transport. Executors wrap calls in
   *         their own retry/backoff — providers should surface real errors
   *         rather than swallow them.
   */
  fetch(config: ResolvedConfig, params: FetchParams): Promise<FetchResult>;

  /**
   * Cheap probe to verify the config is wired correctly.
   * Best-effort: RSS may try a HEAD request, HTTP API a short GET, CP relay
   * a `/health` ping. Never throws — always resolves with `{ ok, error? }`.
   */
  testConnection(config: ResolvedConfig): Promise<TestConnectionResult>;
}
