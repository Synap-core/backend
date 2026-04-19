/**
 * HTTPAPIProvider
 *
 * Generic provider for any JSON HTTP API. Caller supplies:
 *   - endpoint + method + headers + body (headers may include vault:// refs
 *     already resolved by the executor)
 *   - `itemsPath` — simple dot/bracket path into the response JSON to locate
 *     the array of items (e.g. "data.results", "items", "response[0].items")
 *   - `mapping` — property names to read off each item for the universal
 *     SourceItem shape
 *
 * No third-party JSONPath lib — we keep the path grammar minimal and spelled
 * out in `readPath()` below.
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

const MappingSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  externalId: z.string().min(1),
  publishedAt: z.string().min(1),
  excerpt: z.string().optional(),
  author: z.string().optional(),
  imageUrl: z.string().optional(),
});

export const HTTPAPIConfigSchema = z.object({
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** JSON-serialisable body for POST requests. */
  body: z.unknown().optional(),
  /**
   * Path into the response JSON that points at the items array.
   * Dot-delimited with numeric brackets, e.g. "data.results", "items",
   * "response[0].items". If omitted the response itself must be an array.
   */
  itemsPath: z.string().optional(),
  mapping: MappingSchema,
});
export type HTTPAPIConfig = z.infer<typeof HTTPAPIConfigSchema>;

// ── Path reader ──────────────────────────────────────────────────────────────

/**
 * Read a value from an object graph using a minimal path grammar:
 *   "foo.bar"      → obj.foo.bar
 *   "items[0].x"   → obj.items[0].x
 *   ""             → obj (identity)
 *
 * Returns `undefined` at any step that fails rather than throwing.
 */
export function readPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let current: unknown = obj;

  // Tokenise into segments: either a plain key or "key[idx]" chunks.
  const segments = path.split(".").flatMap((part) => {
    const out: string[] = [];
    // pull "name" and "[N]" parts out of "name[1][2]"
    const match = part.match(/^([^\[]*)(.*)$/);
    if (!match) return out;
    if (match[1]) out.push(match[1]);
    const bracketRegex = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = bracketRegex.exec(match[2])) !== null) {
      out.push(m[1]);
    }
    return out;
  });

  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class HTTPAPIProvider implements ISourceProvider {
  readonly meta: SourceProviderMeta = {
    type: "http-api",
    displayName: "HTTP JSON API",
    description:
      "Call any JSON HTTP endpoint and map the response to feed items. Supports GET/POST and custom headers.",
    capabilities: {
      supportsCursor: false,
      supportsTesting: true,
      // Headers MAY contain auth, but the provider doesn't strictly require it.
      requiresAuth: false,
    },
    configSchema: HTTPAPIConfigSchema,
  };

  async fetch(
    config: ResolvedConfig,
    params: FetchParams
  ): Promise<FetchResult> {
    const cfg = HTTPAPIConfigSchema.parse(config);

    const method = cfg.method ?? "GET";
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(cfg.headers ?? {}),
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };

    if (method === "POST" && cfg.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      init.body =
        typeof cfg.body === "string" ? cfg.body : JSON.stringify(cfg.body);
    }

    const response = await fetch(cfg.endpoint, init);
    if (!response.ok) {
      throw new Error(
        `HTTP API fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const json: unknown = await response.json();
    const itemsCandidate = readPath(json, cfg.itemsPath ?? "");
    if (!Array.isArray(itemsCandidate)) {
      throw new Error(
        `HTTP API response at path "${cfg.itemsPath ?? "<root>"}" is not an array`
      );
    }

    const limit = params.limit ?? itemsCandidate.length;
    const items: SourceItem[] = itemsCandidate
      .slice(0, limit)
      .map((rawItem) => mapItem(rawItem, cfg.mapping))
      .filter((it): it is SourceItem => it !== null);

    return { items };
  }

  async testConnection(config: ResolvedConfig): Promise<TestConnectionResult> {
    const parsed = HTTPAPIConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }

    try {
      const result = await this.fetch(parsed.data, { limit: 1 });
      return { ok: true, sampleCount: result.items.length };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── item mapping ─────────────────────────────────────────────────────────────

function mapItem(
  rawItem: unknown,
  mapping: HTTPAPIConfig["mapping"]
): SourceItem | null {
  if (!rawItem || typeof rawItem !== "object") return null;

  const externalId = String(readPath(rawItem, mapping.externalId) ?? "");
  const title = String(readPath(rawItem, mapping.title) ?? "Untitled");
  const url = String(readPath(rawItem, mapping.url) ?? "");
  if (!externalId || !url) return null;

  const publishedRaw = readPath(rawItem, mapping.publishedAt);
  const publishedAt =
    publishedRaw != null ? new Date(String(publishedRaw)) : new Date();

  const excerpt = mapping.excerpt
    ? readPath(rawItem, mapping.excerpt)
    : undefined;
  const author = mapping.author ? readPath(rawItem, mapping.author) : undefined;
  const imageUrl = mapping.imageUrl
    ? readPath(rawItem, mapping.imageUrl)
    : undefined;

  return {
    externalId,
    title,
    url,
    excerpt: excerpt != null ? String(excerpt) : undefined,
    publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    author: author != null ? String(author) : undefined,
    imageUrl: imageUrl != null ? String(imageUrl) : undefined,
    raw: rawItem,
  };
}
