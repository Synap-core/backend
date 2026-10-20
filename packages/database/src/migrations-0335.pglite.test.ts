/**
 * REAL-POSTGRES (PGlite) test for migration 0335 — a webhook subscription
 * names the API key that created it (S2).
 * A pod that booted before 0335 (its `webhook_subscriptions` from the baseline
 * WITHOUT the column) gains `api_key_id` from the migration, idempotently,
 * keeping its rows as session-created (NULL); a fresh install gets it from the
 * baseline. Deleting the key deletes its subscriptions: a key-bound row must
 * never survive as NULL, which reads as a human session's (owner-wide) row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { webhookSubscriptions } from "./schema/webhook_subscriptions.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0335 = readFileSync(
  resolve(HERE, "../migrations/0335_webhook_subscriptions_api_key.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
/** The baseline's own webhook block (CREATE + its ADD COLUMN guards). */
const BASELINE_HOOKS = BASELINE.slice(
  BASELINE.indexOf("-- ─── 51. webhook_subscriptions"),
  BASELINE.indexOf("-- Reactions projection: webhook delivery fan-out")
);
/**
 * The same block as a pod that booted before 0335 ran it (the column was the
 * CREATE's last one, so the comma it leaves on the line before goes too).
 */
const PRE_0335 = BASELINE_HOOKS.split("\n")
  .filter((l) => !l.includes("api_key_id"))
  .join("\n")
  .replace(/,\s*\n\);/, "\n);");
/** The two tables the block references, reduced to their keys. */
const REFERENCED = `
  CREATE TABLE workspaces (id uuid PRIMARY KEY);
  CREATE TABLE api_keys (id uuid PRIMARY KEY);
`;
const declared = getTableConfig(webhookSubscriptions).columns.map(
  (c) => c.name
);
const KEY = "00000000-0000-4000-8000-0000000000aa";

async function columnsOf(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_subscriptions'`
  );
  return r.rows.map((x) => x.column_name).sort();
}

async function subscriptionCount(pg: PGlite): Promise<number> {
  const r = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM webhook_subscriptions`
  );
  return r.rows[0].n;
}

const insertSub = (keyId: string | null) =>
  `INSERT INTO webhook_subscriptions (user_id, name, url, event_types, secret${
    keyId ? ", api_key_id" : ""
  }) VALUES ('u-1','s','https://hook.example/x','{a}','sec'${
    keyId ? `,'${keyId}'` : ""
  })`;

describe("migration 0335 — webhook_subscriptions.api_key_id", () => {
  it("non-vacuity: the schema declares it and the pre-0335 table lacks it", async () => {
    expect(declared).toContain("api_key_id");
    const pg = new PGlite();
    await pg.exec(REFERENCED + PRE_0335);
    expect(await columnsOf(pg)).not.toContain("api_key_id");
  });

  it("an existing pod gains the column, idempotently, keeping its rows as session-created", async () => {
    const pg = new PGlite();
    await pg.exec(REFERENCED + PRE_0335);
    await pg.query(insertSub(null));
    await pg.exec(M0335);
    await pg.exec(M0335);
    expect(await columnsOf(pg)).toEqual([...declared].sort());
    const row = await pg.query<{ api_key_id: unknown }>(
      `SELECT api_key_id FROM webhook_subscriptions`
    );
    expect(row.rows).toEqual([{ api_key_id: null }]);
  });

  it("deleting the key deletes its subscriptions (migrated pod)", async () => {
    const pg = new PGlite();
    await pg.exec(REFERENCED + PRE_0335);
    await pg.exec(M0335);
    await pg.query(`INSERT INTO api_keys (id) VALUES ('${KEY}')`);
    await pg.query(insertSub(KEY));
    await pg.query(insertSub(null));
    await pg.query(`DELETE FROM api_keys WHERE id = '${KEY}'`);
    // The session-created row stays; the key's row is gone, not orphaned.
    const r = await pg.query<{ api_key_id: unknown }>(
      `SELECT api_key_id FROM webhook_subscriptions`
    );
    expect(r.rows).toEqual([{ api_key_id: null }]);
  });

  it("a fresh install gets it from the baseline, with the same cascade", async () => {
    const pg = new PGlite();
    await pg.exec(REFERENCED + BASELINE_HOOKS);
    expect(await columnsOf(pg)).toEqual([...declared].sort());
    await pg.query(`INSERT INTO api_keys (id) VALUES ('${KEY}')`);
    await pg.query(insertSub(KEY));
    await pg.query(`DELETE FROM api_keys WHERE id = '${KEY}'`);
    expect(await subscriptionCount(pg)).toBe(0);
  });

  it("boot coherence names the column, attributed to the 0335 file", () => {
    const mine = REQUIRED_COLUMNS.filter(
      (c) => c.table === "webhook_subscriptions" && c.column === "api_key_id"
    );
    expect(mine.map((c) => c.addedBy)).toEqual([
      "0335_webhook_subscriptions_api_key.sql",
    ]);
  });
});
