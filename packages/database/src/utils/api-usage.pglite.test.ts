/**
 * REAL-POSTGRES (PGlite) proof for API usage telemetry (0364).
 *
 * The REAL migration builds the table (applied twice: idempotent), and the
 * REAL drizzle builders write, expire and read it:
 *   - a flush is ONE statement, and a second flush of the same tuples ADDS
 *     (including tuples whose key and conversation are NULL: the unique key is
 *     NULLS NOT DISTINCT, or a 429 row would duplicate on every flush);
 *   - retention deletes buckets older than 30 days and keeps the rest;
 *   - the read groups by the asked dimensions, largest first;
 *   - the Drizzle schema, the fresh-DB baseline and the boot coherence list
 *     all carry the table.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { apiUsageBuckets } from "../schema/api-usage-buckets.js";
import { REQUIRED_COLUMNS } from "./schema-coherence.js";
import {
  ApiUsageCounter,
  deleteExpiredApiUsage,
  flushApiUsage,
  readApiUsage,
  type ApiUsageDims,
  type UsageDb,
} from "./api-usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../../migrations/${f}`), "utf8");
const FILE = "0364_api_usage_buckets.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

const KEY = "a0000000-0000-4000-8000-000000000001";
const NOW = Date.UTC(2026, 9, 27, 12, 2, 0);

let pg: PGlite;
let db: UsageDb;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
  db = drizzle(pg) as unknown as UsageDb;
});

const dims = (over: Partial<ApiUsageDims> = {}): ApiUsageDims => ({
  apiKeyId: KEY,
  limiterKey: "key:abc",
  client: "synap-bridge/0.6.0",
  conversationId: "claude-code:c1",
  rlClass: "crud",
  outcome: "2xx",
  ...over,
});

async function all() {
  const r = await pg.query<{
    client: string;
    outcome: string;
    calls: number;
    api_key_id: string | null;
  }>(
    `SELECT client, outcome, calls, api_key_id FROM api_usage_buckets ORDER BY client, outcome`
  );
  return r.rows;
}

describe("0364 api_usage_buckets", () => {
  it("a flush is one statement; a second flush of the same tuples adds, NULL dims included", async () => {
    await pg.exec("DELETE FROM api_usage_buckets");
    const counter = new ApiUsageCounter();
    for (let i = 0; i < 3; i++) counter.record(dims(), 10, NOW);
    counter.record(dims({ client: "synap-cli-mcp/1.13.0" }), 5, NOW);
    // A refused call before auth: no key, no conversation.
    counter.record(
      dims({ apiKeyId: null, conversationId: null, outcome: "429" }),
      1,
      NOW
    );

    const spy = vi.spyOn(pg, "query");
    const execSpy = vi.spyOn(pg, "exec");
    expect(await flushApiUsage(counter.drain(), db)).toBe(3);
    expect(spy.mock.calls.length + execSpy.mock.calls.length).toBe(1);
    spy.mockRestore();
    execSpy.mockRestore();

    // The same tuples again, in the same bucket.
    counter.record(dims(), 10, NOW + 60_000);
    counter.record(
      dims({ apiKeyId: null, conversationId: null, outcome: "429" }),
      1,
      NOW + 60_000
    );
    await flushApiUsage(counter.drain(), db);

    const rows = await all();
    expect(rows).toHaveLength(3);
    const bridge2xx = rows.find(
      (r) => r.client === "synap-bridge/0.6.0" && r.outcome === "2xx"
    )!;
    const bridge429 = rows.find((r) => r.outcome === "429")!;
    expect(bridge2xx.calls).toBe(4);
    expect(bridge429.calls).toBe(2);
    expect(bridge429.api_key_id).toBeNull();
  });

  it("retention deletes buckets older than 30 days and keeps the rest", async () => {
    await pg.exec("DELETE FROM api_usage_buckets");
    const counter = new ApiUsageCounter();
    counter.record(dims({ client: "old" }), 1, NOW - 31 * 86_400_000);
    counter.record(dims({ client: "edge" }), 1, NOW - 29 * 86_400_000);
    counter.record(dims({ client: "new" }), 1, NOW);
    await flushApiUsage(counter.drain(), db);
    expect(await deleteExpiredApiUsage(db, 30, new Date(NOW))).toBe(1);
    expect((await all()).map((r) => r.client).sort()).toEqual(["edge", "new"]);
  });

  it("reads grouped by the asked dimensions, largest first", async () => {
    await pg.exec("DELETE FROM api_usage_buckets");
    const counter = new ApiUsageCounter();
    for (let i = 0; i < 5; i++)
      counter.record(dims({ conversationId: `claude-code:c${i}` }), 1, NOW);
    for (let i = 0; i < 2; i++)
      counter.record(dims({ client: "synap-cli-mcp/1.13.0" }), 1, NOW);
    counter.record(
      dims({ client: "synap-cli-mcp/1.13.0", outcome: "429" }),
      1,
      NOW
    );
    counter.record(
      dims({ apiKeyId: "b0000000-0000-4000-8000-000000000002" }),
      1,
      NOW
    );
    await flushApiUsage(counter.drain(), db);

    const r = await readApiUsage(db, {
      apiKeyId: KEY,
      groupBy: ["client"],
      since: new Date(NOW - 86_400_000),
      until: new Date(NOW + 86_400_000),
    });
    expect(r.groupBy).toEqual(["client"]);
    expect(r.groups).toEqual([
      { client: "synap-bridge/0.6.0", calls: 5, heldMs: 5, conversations: 5 },
      { client: "synap-cli-mcp/1.13.0", calls: 3, heldMs: 3, conversations: 1 },
    ]);

    const byHour = await readApiUsage(db, {
      groupBy: ["hour", "outcome"],
      since: new Date(NOW - 86_400_000),
      until: new Date(NOW + 86_400_000),
    });
    expect(byHour.groups[0]).toMatchObject({
      hour: new Date(Date.UTC(2026, 9, 27, 12)).toISOString(),
      outcome: "2xx",
      calls: 8,
    });
  });

  it("schema, baseline and coherence carry the table", () => {
    const cfg = getTableConfig(apiUsageBuckets);
    expect(cfg.name).toBe("api_usage_buckets");
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        "api_key_id",
        "bucket_start",
        "calls",
        "client",
        "conversation_id",
        "held_ms",
        "limiter_key",
        "outcome",
        "rl_class",
      ].sort()
    );
    expect(BASELINE).toContain(
      `CREATE TABLE IF NOT EXISTS "api_usage_buckets"`
    );
    expect(BASELINE).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "api_usage_buckets").map(
        (c) => c.addedBy
      )
    ).toEqual([FILE, FILE]);
  });
});
