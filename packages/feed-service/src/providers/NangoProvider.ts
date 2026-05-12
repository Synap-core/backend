/**
 * NangoProvider — Feed source provider for Nango-synced records.
 *
 * Pulls records from a self-hosted Nango instance via its Records API and
 * normalises them into the universal `SourceItem` shape. Credentials are
 * read from environment variables (`NANGO_HOST`, `NANGO_SECRET_KEY`) — the
 * same variables written to `deploy/.env` by `eve add nango`.
 *
 * Config (stored in `source_subscriptions.config`):
 *   connectionId  — Nango connection ID (e.g. "userId:podId:google-mail")
 *   model         — Nango sync model name (e.g. "Email", "Contact", "Event")
 *
 * Cursor: ISO timestamp of the most-recently-seen record (`last_modified_at`).
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

// ── Config schema ────────────────────────────────────────────────────────────

export const NangoProviderConfigSchema = z.object({
  connectionId: z.string().min(1),
  model: z.string().min(1),
});
export type NangoProviderConfig = z.infer<typeof NangoProviderConfigSchema>;

// ── Nango API response shapes ────────────────────────────────────────────────

const NangoRecordSchema = z
  .object({
    _nango_metadata: z.object({
      last_modified_at: z.string(),
      last_action: z.enum(["ADDED", "UPDATED", "DELETED"]),
    }),
  })
  .catchall(z.unknown());

const NangoRecordsResponseSchema = z.object({
  records: z.array(NangoRecordSchema),
  next_cursor: z.string().nullable().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function nangoHost(): string {
  return process.env.NANGO_HOST ?? "http://localhost:3003";
}

function nangoKey(): string | undefined {
  return process.env.NANGO_SECRET_KEY;
}

/** Pick the first truthy string value from a record by candidate keys. */
function pick(record: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Map a raw Nango record to a `SourceItem`. Best-effort field mapping. */
function toSourceItem(
  record: Record<string, unknown>,
  lastModified: string
): SourceItem {
  const id = String(record.id ?? record.externalId ?? lastModified);
  const title =
    pick(record, ["title", "name", "summary", "subject", "display_name"]) || id;
  const url = pick(record, ["html_url", "url", "link", "calendarLink"]) || "";
  const excerpt = pick(record, [
    "description",
    "body_text",
    "snippet",
    "content",
    "notes",
  ]);
  const author = pick(record, [
    "from_name",
    "from_email",
    "author",
    "owner_login",
  ]);
  return {
    externalId: id,
    title,
    url,
    excerpt: excerpt || undefined,
    author: author || undefined,
    publishedAt: new Date(
      pick(record, ["date", "created_at", "start_datetime"]) || lastModified
    ),
    raw: record,
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class NangoProvider implements ISourceProvider {
  readonly meta: SourceProviderMeta = {
    type: "nango-sync",
    displayName: "Nango Sync",
    description:
      "Fetch records from a self-hosted Nango integration (Google Mail, Contacts, Calendar, GitHub, …)",
    capabilities: {
      supportsCursor: true,
      supportsTesting: true,
      requiresAuth: true,
    },
    configSchema: NangoProviderConfigSchema,
  };

  async fetch(
    config: ResolvedConfig,
    params: FetchParams
  ): Promise<FetchResult> {
    const key = nangoKey();
    if (!key) {
      return { items: [], nextToken: params.sinceToken };
    }

    const parsed = NangoProviderConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        `NangoProvider: invalid config — ${parsed.error.message}`
      );
    }

    const { connectionId, model } = parsed.data;

    const url = new URL(`${nangoHost()}/records`);
    url.searchParams.set("model", model);
    url.searchParams.set("connection_id", connectionId);
    if (params.sinceToken) {
      url.searchParams.set("modified_after", params.sinceToken);
    }
    if (params.limit) {
      url.searchParams.set("limit", String(params.limit));
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(
        `NangoProvider fetch failed: ${res.status} ${res.statusText}`
      );
    }

    const body = await res.json();
    const data = NangoRecordsResponseSchema.safeParse(body);
    if (!data.success) {
      throw new Error(
        `NangoProvider: unexpected response shape — ${data.error.message}`
      );
    }

    const activeRecords = data.data.records.filter(
      (r) => r._nango_metadata.last_action !== "DELETED"
    );

    const items: SourceItem[] = activeRecords.map((r) => {
      const { _nango_metadata, ...rest } = r;
      return toSourceItem(
        rest as Record<string, unknown>,
        _nango_metadata.last_modified_at
      );
    });

    // Next cursor = latest last_modified_at across all returned records
    const latestTs = activeRecords
      .map((r) => r._nango_metadata.last_modified_at)
      .sort()
      .pop();

    return {
      items,
      nextToken: latestTs ?? params.sinceToken,
    };
  }

  async testConnection(config: ResolvedConfig): Promise<TestConnectionResult> {
    try {
      const result = await this.fetch(config, { limit: 1 });
      return { ok: true, sampleCount: result.items.length };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
