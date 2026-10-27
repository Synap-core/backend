/**
 * REAL-POSTGRES (PGlite) proof for the usage table (0364) and its doors.
 *
 * The table is built by the REAL migration (applied twice: idempotent); the
 * writes and reads go through the REAL drizzle builders in `api-usage.ts`.
 *
 * Pinned:
 *   - the flush is ONE statement for every tuple, and a second flush of the
 *     same tuples ADDS (calls + excluded.calls) — including tuples whose key
 *     or conversation is NULL, which a plain UNIQUE would let duplicate;
 *   - retention deletes buckets older than 30 days and keeps the rest;
 *   - the read groups as asked, counts distinct conversations, and narrows
 *     to one key;
 *   - the schema, the baseline and the boot coherence list agree with 0364.
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
const OTHER = "a0000000-0000-4000-8000-000000000002";
const CONV = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

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
  conversationId: CONV,
  rlClass: "crud",
  outcome: "2xx",
  ...over,
});

const total = async () =>
  (
    await pg.query<{ rows: number; calls: number }>(
      `SELECT count(*)::int AS rows, coalesce(sum(calls), 0)::int AS calls FROM api_usage_buckets`
    )
  ).rows[0]!;

describe("0364 api_usage_buckets", () => {
  it("one flush is one statement; a second flush adds, NULL dimensions included", async () => {
    await pg.exec(`DELETE FROM api_usage_buckets`);
    const at = Date.UTC(2026, 9, 27, 10, 2);
    const counter = new ApiUsageCounter();
    for (let i = 0; i < 3; i++) counter.record(dims(), 10, at);
    counter.record(dims({ client: "synap-cli-mcp/1.13.0" }), 5, at);
    // Refused before auth: no key, no conversation (NULLs in the unique key).
    for (let i = 0; i < 2; i++) {
      counter.record(
        dims({ apiKeyId: null, conversationId: null, outcome: "429" }),
        1,
        at
      );
    }
    const rows = counter.drain();
    expect(rows).toHaveLength(3);

    const spy = vi.spyOn(pg, "query");
    await flushApiUsage(rows, db);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await total()).toEqual({ rows: 3, calls: 6 });

    // The same tuples again: counts add up, no duplicate rows.
    await flushApiUsage(rows, db);
    expect(await total()).toEqual({ rows: 3, calls: 12 });
    const limited = await pg.query<{ calls: number; held_ms: number }>(
      `SELECT calls, held_ms::int AS held_ms FROM api_usage_buckets WHERE outcome = '429'`
    );
    expect(limited.rows).toEqual([{ calls: 4, held_ms: 4 }]);
  });

  it("retention deletes buckets older than 30 days and keeps the rest", async () => {
    await pg.exec(`DELETE FROM api_usage_buckets`);
    const now = new Date("2026-10-27T12:00:00Z");
    const c = new ApiUsageCounter();
    c.record(dims(), 1, now.getTime() - 31 * 86_400_000);
    c.record(
      dims({ client: "old-but-kept" }),
      1,
      now.getTime() - 29 * 86_400_000
    );
    c.record(dims({ client: "today" }), 1, now.getTime() - 60_000);
    await flushApiUsage(c.drain(), db);
    expect((await total()).rows).toBe(3);

    expect(await deleteExpiredApiUsage(db, 30, now)).toBe(1);
    const left = await pg.query<{ client: string }>(
      `SELECT client FROM api_usage_buckets ORDER BY client`
    );
    expect(left.rows.map((r) => r.client)).toEqual(["old-but-kept", "today"]);
  });

  it("reads grouped as asked, with distinct conversations, narrowed to one key", async () => {
    await pg.exec(`DELETE FROM api_usage_buckets`);
    const at = Date.now() - 60_000;
    const c = new ApiUsageCounter();
    for (let i = 0; i < 4; i++) c.record(dims(), 1, at);
    c.record(dims({ conversationId: "claude-code:other" }), 1, at);
    c.record(dims({ client: "synap-cli-mcp/1.13.0" }), 1, at);
    c.record(dims({ apiKeyId: OTHER, client: "elsewhere" }), 1, at);
    await flushApiUsage(c.drain(), db);

    const r = await readApiUsage(db, {
      apiKeyId: KEY,
      groupBy: ["client", "outcome"],
      since: new Date(Date.now() - 7 * 86_400_000),
    });
    expect(r.groupBy).toEqual(["client", "outcome"]);
    expect(r.groups).toEqual([
      {
        client: "synap-bridge/0.6.0",
        outcome: "2xx",
        calls: 5,
        heldMs: 5,
        conversations: 2,
      },
      {
        client: "synap-cli-mcp/1.13.0",
        outcome: "2xx",
        calls: 1,
        heldMs: 1,
        conversations: 1,
      },
    ]);
  });

  it("schema, baseline and boot coherence agree with 0364", () => {
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
    expect(cfg.uniqueConstraints[0]?.nullsNotDistinct).toBe(true);
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
