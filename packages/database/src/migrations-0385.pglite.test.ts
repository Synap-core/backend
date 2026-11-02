/**
 * REAL-POSTGRES (PGlite) test for migration 0385 — `api_keys.worker_served_at`
 * and `worker_served_version` (computers plan v2 S3 step 1): when a process
 * running an agent last called with the key. Both nullable, no backfill (NULL
 * = not measured). The migration is idempotent, and the baseline carries the
 * columns, so both match the drizzle schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { apiKeys } from "./schema/api-keys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0385 = read("0385_api_keys_worker_served.sql");
const BASELINE = read("0000_baseline_schema.sql");

/** The baseline's api_keys section, plus the one column it adds further down. */
const KEYS_BLOCK =
  BASELINE.slice(
    BASELINE.indexOf("-- ─── 37. api_keys"),
    BASELINE.indexOf("-- ─── 38. provisioning_tokens")
  ) +
  `\nALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "parent_key_id" uuid;\n`;

const NEW_COLUMNS = ["worker_served_at", "worker_served_version"];

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'`
    )
  ).rows.map((r) => r.column_name);

describe("migration 0385 — api_keys.worker_served_at / worker_served_version", () => {
  it("adds both nullable columns, twice without error, keeping existing rows", async () => {
    const pg = new PGlite();
    // A pod before 0385: the baseline section WITHOUT the new columns.
    await pg.exec(
      KEYS_BLOCK.split("\n")
        .filter((l) => !NEW_COLUMNS.some((c) => l.includes(c)))
        .join("\n")
    );
    for (const c of NEW_COLUMNS) expect(await columns(pg)).not.toContain(c);
    await pg.exec(
      `INSERT INTO api_keys (user_id, key_name, key_prefix, key_hash)
       VALUES ('agent-a', 'a', 'synap_hub_live_', 'hash-a')`
    );

    await pg.exec(M0385);
    await pg.exec(M0385);

    const { rows } = await pg.query<Record<string, unknown>>(
      `SELECT worker_served_at, worker_served_version FROM api_keys`
    );
    expect(rows).toEqual([
      { worker_served_at: null, worker_served_version: null },
    ]);
    await pg.close();
  });

  it("the baseline and the migration both match every column the schema declares", async () => {
    const declared = getTableConfig(apiKeys)
      .columns.map((c) => c.name)
      .sort();
    for (const c of NEW_COLUMNS) expect(declared).toContain(c);

    const base = new PGlite();
    await base.exec(KEYS_BLOCK);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.exec(M0385);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.close();
  });
});
