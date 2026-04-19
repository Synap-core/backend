/**
 * CPRelayProvider
 *
 * Forwards a fetch request to a remote "relay" (typically the Synap Control
 * Plane) that proxies calls to upstream sources the Pod can't or shouldn't
 * reach directly (RSSHub-at-scale, SerpAPI with a shared key, SEC EDGAR with
 * cached rate limits, …).
 *
 * The relay is just ONE of many providers — a Pod that doesn't want to use
 * CP at all never installs a CPRelay source_config. This is why the provider
 * lives in the Pod-side feed-service package rather than in the CP client.
 *
 * Wire format:
 *   POST ${relayUrl}/api/sources/relay
 *   Authorization: Bearer <relayKey>
 *   Content-Type: application/json
 *   Body:
 *     { upstreamType: string,
 *       config:       Record<string, unknown>,
 *       sinceToken?:  string,
 *       limit?:       number }
 *
 *   Response: { items: SourceItem[], nextToken?: string, pollAfterSeconds?: number }
 *
 * The relay is expected to echo back items in already-normalised SourceItem
 * shape; this keeps the provider thin and avoids duplicating upstream-specific
 * parsers on the Pod.
 */

import { z } from "zod";
import type {
  ISourceProvider,
  ResolvedConfig,
  FetchParams,
  FetchResult,
  SourceItem,
  SourceProviderMeta,
  TestConnectionResult,
} from "./ISourceProvider.js";

// ── Config Schema ────────────────────────────────────────────────────────────

export const CPRelayConfigSchema = z.object({
  relayUrl: z.string().url(),
  /** Bearer key for the relay. Plaintext after vault resolution. */
  relayKey: z.string().min(1),
  /** Identifier the relay uses to dispatch to the right upstream. */
  upstreamType: z.string().min(1),
  /** Opaque config forwarded to the relay. */
  upstreamConfig: z.record(z.string(), z.unknown()),
});
export type CPRelayConfig = z.infer<typeof CPRelayConfigSchema>;

// ── Response Schema ──────────────────────────────────────────────────────────

const RelayItemSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  excerpt: z.string().optional(),
  publishedAt: z.union([z.string(), z.number()]),
  author: z.string().optional(),
  imageUrl: z.string().optional(),
  raw: z.unknown().optional(),
});

const RelayResponseSchema = z.object({
  items: z.array(RelayItemSchema),
  nextToken: z.string().optional(),
  pollAfterSeconds: z.number().optional(),
});

function normalisePublishedAt(value: string | number): Date {
  if (typeof value === "number") {
    return new Date(value);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function translateItem(item: z.infer<typeof RelayItemSchema>): SourceItem {
  return {
    externalId: item.externalId,
    title: item.title,
    url: item.url,
    excerpt: item.excerpt,
    publishedAt: normalisePublishedAt(item.publishedAt),
    author: item.author,
    imageUrl: item.imageUrl,
    raw: item.raw,
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class CPRelayProvider implements ISourceProvider {
  readonly meta: SourceProviderMeta = {
    type: "cp-relay",
    displayName: "Control Plane Relay",
    description:
      "Forward fetches to a Synap Control Plane (or compatible) relay that proxies upstream sources the Pod cannot reach directly.",
    capabilities: {
      supportsCursor: true,
      supportsTesting: true,
      requiresAuth: true,
    },
    configSchema: CPRelayConfigSchema,
  };

  async fetch(
    config: ResolvedConfig,
    params: FetchParams
  ): Promise<FetchResult> {
    const cfg = CPRelayConfigSchema.parse(config);

    const url = `${cfg.relayUrl.replace(/\/$/, "")}/api/sources/relay`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.relayKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        upstreamType: cfg.upstreamType,
        config: cfg.upstreamConfig,
        sinceToken: params.sinceToken,
        limit: params.limit,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `CP relay fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const rawJson: unknown = await response.json();
    const parsed = RelayResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(
        `CP relay returned unexpected response shape: ${parsed.error.message}`
      );
    }

    return {
      items: parsed.data.items.map(translateItem),
      nextToken: parsed.data.nextToken,
      pollAfterSeconds: parsed.data.pollAfterSeconds,
    };
  }

  async testConnection(config: ResolvedConfig): Promise<TestConnectionResult> {
    const parsed = CPRelayConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }

    try {
      const url = `${parsed.data.relayUrl.replace(/\/$/, "")}/health`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${parsed.data.relayKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Relay /health returned HTTP ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
