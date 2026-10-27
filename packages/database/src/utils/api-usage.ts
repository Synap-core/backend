/**
 * API USAGE TELEMETRY (0364) — count calls in memory, flush them in one
 * batched upsert, expire them after 30 days, read them back grouped.
 *
 * The counter is per process and holds one tuple per (5-minute bucket,
 * dimensions) seen since the last flush. `flushApiUsage` writes every tuple in
 * ONE statement (`calls = calls + excluded.calls`), so a request never writes
 * to the database; the API's usage middleware calls it once a minute
 * (`apps/api/src/middleware/usage-telemetry.ts`).
 *
 * WHAT IT DOES NOT COVER: a process that dies between flushes loses up to a
 * minute of counts (SIGTERM flushes first); counts are per request, not per
 * MCP tool call inside a batch.
 */

import { and, gte, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { apiUsageBuckets } from "../schema/api-usage-buckets.js";

/** Any drizzle Postgres handle (the pod's `db`, a transaction, PGlite in tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UsageDb = PgDatabase<PgQueryResultHKT, any, any>;

export const API_USAGE_BUCKET_MS = 5 * 60_000;
export const API_USAGE_RETENTION_DAYS = 30;

export type ApiUsageOutcome = "2xx" | "3xx" | "4xx" | "429" | "5xx";

/** The dimensions of one count. Every field is part of the unique key. */
export interface ApiUsageDims {
  apiKeyId: string | null;
  limiterKey: string;
  client: string;
  conversationId: string | null;
  rlClass: string;
  outcome: ApiUsageOutcome;
}

export interface ApiUsageRow extends ApiUsageDims {
  bucketStart: Date;
  calls: number;
  heldMs: number;
}

/** The outcome bucket of an HTTP status. */
export function usageOutcome(status: number): ApiUsageOutcome {
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/** Start of the 5-minute bucket `at` falls in. */
export function usageBucketStart(at: number): Date {
  return new Date(Math.floor(at / API_USAGE_BUCKET_MS) * API_USAGE_BUCKET_MS);
}

/**
 * In-memory counts since the last drain. `maxTuples` bounds memory when the
 * database is unreachable for long: past it, a NEW tuple is dropped and
 * counted in `dropped` (an existing tuple still counts).
 */
export class ApiUsageCounter {
  private readonly rows = new Map<string, ApiUsageRow>();
  dropped = 0;

  constructor(private readonly maxTuples = 50_000) {}

  get size(): number {
    return this.rows.size;
  }

  record(dims: ApiUsageDims, heldMs: number, at: number = Date.now()): void {
    const bucketStart = usageBucketStart(at);
    this.add({ ...dims, bucketStart, calls: 1, heldMs: Math.max(0, heldMs) });
  }

  /** Merge a row back (a flush that failed keeps its counts for the next one). */
  add(row: ApiUsageRow): void {
    const key = JSON.stringify([
      row.bucketStart.getTime(),
      row.apiKeyId,
      row.limiterKey,
      row.client,
      row.conversationId,
      row.rlClass,
      row.outcome,
    ]);
    const prev = this.rows.get(key);
    if (prev) {
      prev.calls += row.calls;
      prev.heldMs += row.heldMs;
      return;
    }
    if (this.rows.size >= this.maxTuples) {
      this.dropped += row.calls;
      return;
    }
    this.rows.set(key, { ...row });
  }

  /** Every tuple counted so far; the counter is empty afterwards. */
  drain(): ApiUsageRow[] {
    const out = [...this.rows.values()];
    this.rows.clear();
    return out;
  }
}

/**
 * Write `rows` in ONE upsert. Rows of the same tuple already stored are added
 * to (`calls + excluded.calls`), so two processes, or two flushes in one
 * bucket, never overwrite each other. Empty → no statement.
 */
export async function flushApiUsage(
  rows: readonly ApiUsageRow[],
  executor: UsageDb
): Promise<number> {
  if (rows.length === 0) return 0;
  const t = apiUsageBuckets;
  await executor
    .insert(t)
    .values(
      rows.map((r) => ({
        bucketStart: r.bucketStart,
        apiKeyId: r.apiKeyId,
        limiterKey: r.limiterKey,
        client: r.client,
        conversationId: r.conversationId,
        rlClass: r.rlClass,
        outcome: r.outcome,
        calls: r.calls,
        heldMs: Math.round(r.heldMs),
      }))
    )
    .onConflictDoUpdate({
      target: [
        t.bucketStart,
        t.apiKeyId,
        t.limiterKey,
        t.client,
        t.conversationId,
        t.rlClass,
        t.outcome,
      ],
      set: {
        calls: sql`${t.calls} + excluded.calls`,
        heldMs: sql`${t.heldMs} + excluded.held_ms`,
      },
    });
  return rows.length;
}

/** Delete buckets older than `days` (default 30). Returns how many rows went. */
export async function deleteExpiredApiUsage(
  executor: UsageDb,
  days: number = API_USAGE_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const gone = await executor
    .delete(apiUsageBuckets)
    .where(lt(apiUsageBuckets.bucketStart, cutoff))
    .returning({ bucketStart: apiUsageBuckets.bucketStart });
  return gone.length;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** What a usage read may group by. `hour` / `day` truncate the bucket. */
export const API_USAGE_GROUP_BY = [
  "hour",
  "day",
  "apiKeyId",
  "limiterKey",
  "client",
  "conversationId",
  "rlClass",
  "outcome",
] as const;
export type ApiUsageGroupBy = (typeof API_USAGE_GROUP_BY)[number];

export const API_USAGE_DEFAULT_GROUP_BY: readonly ApiUsageGroupBy[] = [
  "client",
  "rlClass",
  "outcome",
];

export interface ApiUsageQuery {
  /** Inclusive lower bound (default: 24 h ago). */
  since?: Date;
  /** Exclusive upper bound (default: now + one bucket). */
  until?: Date;
  groupBy?: readonly ApiUsageGroupBy[];
  apiKeyId?: string;
  client?: string;
  /** Max groups returned, largest first (default 200, max 1000). */
  limit?: number;
}

export interface ApiUsageGroup {
  /** Only the dimensions grouped by are present. */
  hour?: string;
  day?: string;
  apiKeyId?: string | null;
  limiterKey?: string;
  client?: string;
  conversationId?: string | null;
  rlClass?: string;
  outcome?: string;
  calls: number;
  heldMs: number;
  /** Distinct conversations behind the group (a NULL conversation is not one). */
  conversations: number;
}

/** Group-by → its SQL expression (a closed map: nothing from the caller is spliced). */
function groupExpr(g: ApiUsageGroupBy): SQL {
  const t = apiUsageBuckets;
  switch (g) {
    case "hour":
      return sql`date_trunc('hour', ${t.bucketStart})`;
    case "day":
      return sql`date_trunc('day', ${t.bucketStart})`;
    case "apiKeyId":
      return sql`${t.apiKeyId}`;
    case "limiterKey":
      return sql`${t.limiterKey}`;
    case "client":
      return sql`${t.client}`;
    case "conversationId":
      return sql`${t.conversationId}`;
    case "rlClass":
      return sql`${t.rlClass}`;
    case "outcome":
      return sql`${t.outcome}`;
  }
}

/**
 * Calls grouped by the asked dimensions, largest first. The answer to "how
 * much of the claude-code key does the bridge use":
 * `{ apiKeyId: <key>, groupBy: ["client", "outcome"], since: <7 days ago> }`.
 */
export async function readApiUsage(
  executor: UsageDb,
  q: ApiUsageQuery = {}
): Promise<{ since: string; until: string; groupBy: ApiUsageGroupBy[]; groups: ApiUsageGroup[] }> {
  const t = apiUsageBuckets;
  const now = Date.now();
  const since = q.since ?? new Date(now - 86_400_000);
  const until = q.until ?? new Date(now + API_USAGE_BUCKET_MS);
  const groupBy = [
    ...new Set(
      (q.groupBy?.length ? q.groupBy : API_USAGE_DEFAULT_GROUP_BY).filter((g) =>
        (API_USAGE_GROUP_BY as readonly string[]).includes(g)
      )
    ),
  ];
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 200)), 1000);

  const where = [gte(t.bucketStart, since), lt(t.bucketStart, until)];
  if (q.apiKeyId) where.push(sql`${t.apiKeyId} = ${q.apiKeyId}`);
  if (q.client) where.push(sql`${t.client} = ${q.client}`);

  const selected: Record<string, SQL> = {};
  for (const g of groupBy) selected[g] = groupExpr(g);

  const rows = await executor
    .select({
      ...selected,
      calls: sql<string>`sum(${t.calls})`,
      heldMs: sql<string>`sum(${t.heldMs})`,
      conversations: sql<string>`count(DISTINCT ${t.conversationId})`,
    })
    .from(t)
    .where(and(...where))
    .groupBy(...groupBy.map(groupExpr))
    .orderBy(sql`sum(${t.calls}) DESC`)
    .limit(limit);

  const groups = (rows as Record<string, unknown>[]).map((r) => {
    const g: ApiUsageGroup = {
      calls: Number(r.calls),
      heldMs: Number(r.heldMs),
      conversations: Number(r.conversations),
    };
    for (const key of groupBy) {
      const v = r[key];
      (g as unknown as Record<string, unknown>)[key] =
        key === "hour" || key === "day"
          ? new Date(v as string | Date).toISOString()
          : (v as string | null);
    }
    return g;
  });
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    groupBy,
    groups,
  };
}
