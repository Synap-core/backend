/**
 * REAL-POSTGRES (PGlite) test for migrations 0429-0431 — compute lifecycle
 * (plan a640c5bb B3, founder decisions of 18 Nov 2026):
 *   - 0429 seeds provision_compute and release_compute, both `act`;
 *   - 0430 adds the `compute_spend_daily_cents` ceiling axis, inside a
 *     transaction, idempotently;
 *   - 0431 seeds the `compute` need (its four intents) and creates
 *     `compute_leases` with the drizzle schema's columns, refusing a lease
 *     with no TTL, no spend maximum or an unknown state;
 *   - every file runs twice (idempotent);
 *   - the baseline carries the axis and the table; the boot coherence list
 *     names the table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { computeLeases } from "./schema/compute-leases.js";
import { GOVERNANCE_CEILING_AXES } from "./schema/governance-ceilings.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0283 = read("0283_capability_intents.sql");
const M0409 = read("0409_installations.sql");
const M0426 = read("0426_needs.sql");
const M0429 = read("0429_compute_intents.sql");
const M0430 = read("0430_compute_spend_ceiling.sql");
const M0431 = read("0431_compute_need_and_leases.sql");
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE capabilities (id uuid PRIMARY KEY);
    CREATE TABLE api_keys (id uuid PRIMARY KEY);
    CREATE TABLE skills (id uuid PRIMARY KEY);
    CREATE TYPE governance_ceiling_axis AS ENUM ('daily_write_count');
  `);
  await pg.exec(M0283);
  await pg.exec(M0409);
  await pg.exec(M0426);
  for (let i = 0; i < 2; i++) {
    await pg.exec(M0429);
    await pg.exec(`BEGIN; ${M0430} COMMIT;`);
    await pg.exec(M0431);
  }
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const lease = (over: Record<string, unknown> = {}) => {
  const row = {
    user_id: "u",
    provision_verb: "cloud_create",
    release_verb: "cloud_delete",
    ttl_minutes: 60,
    max_spend_cents: 300,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
  const cols = Object.keys(row);
  return pg.query(
    `INSERT INTO compute_leases (${cols.join(", ")}) VALUES (${cols
      .map((_, i) => `$${i + 1}`)
      .join(", ")})`,
    Object.values(row)
  );
};

describe("migrations 0429-0431 — compute lifecycle", () => {
  it("0429 seeds the two compute intents, both act", async () => {
    const { rows } = await pg.query<{ slug: string; effect: string }>(
      `SELECT slug, effect FROM capability_intents
       WHERE slug IN ('provision_compute', 'release_compute') ORDER BY slug`
    );
    expect(rows).toEqual([
      { slug: "provision_compute", effect: "act" },
      { slug: "release_compute", effect: "act" },
    ]);
  });

  it("0430 adds the compute spend axis the drizzle enum declares", async () => {
    const { rows } = await pg.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::governance_ceiling_axis))::text AS v`
    );
    expect(rows.map((r) => r.v)).toContain("compute_spend_daily_cents");
    expect(GOVERNANCE_CEILING_AXES).toContain("compute_spend_daily_cents");
  });

  it("0431 seeds the compute need with its four intents", async () => {
    const { rows } = await pg.query<{ intents: string[]; aliases: string[] }>(
      `SELECT intents, aliases FROM needs WHERE slug = 'compute'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intents).toEqual([
      "provision_compute",
      "run_external_job",
      "fetch_record",
      "release_compute",
    ]);
  });

  it("0431 creates compute_leases with the drizzle columns", async () => {
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'compute_leases'`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      getTableConfig(computeLeases)
        .columns.map((c) => c.name)
        .sort()
    );
    await lease();
    const { rows } = await pg.query<{
      state: string;
      release_attempts: number;
    }>(`SELECT state, release_attempts FROM compute_leases`);
    expect(rows[0]).toEqual({ state: "starting", release_attempts: 0 });
  });

  it.each([
    ["no TTL", { ttl_minutes: 0 }, /compute_leases_ttl_check/],
    ["no spend maximum", { max_spend_cents: 0 }, /compute_leases_spend_check/],
    ["an unknown state", { state: "paused" }, /compute_leases_state_check/],
  ])("refuses a lease with %s", async (_label, over, why) => {
    await expect(lease(over)).rejects.toThrow(why);
  });

  it("the baseline carries the axis and the table; boot coherence names it", () => {
    expect(BASELINE).toContain(
      "ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'compute_spend_daily_cents';"
    );
    expect(BASELINE).toContain('CREATE TABLE IF NOT EXISTS "compute_leases"');
    expect(BASELINE).toContain("compute_leases_state_check");
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "compute_leases").map(
        (c) => c.addedBy
      )
    ).toContain("0431_compute_need_and_leases.sql");
  });
});
