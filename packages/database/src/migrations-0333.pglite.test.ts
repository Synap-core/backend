/**
 * REAL-POSTGRES (PGlite) test for migration 0333 — Home's last-seen stamp.
 * A pod that booted before 0333 (its `user_preferences` from the baseline
 * WITHOUT the column) gains `home_last_seen_at` from the migration,
 * idempotently, keeping its rows; a fresh install gets it from the baseline.
 * Either way the table carries every column the drizzle schema declares
 * (schema-coherence checks the column by name at boot).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { userPreferences } from "./schema/user-preferences.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0333 = readFileSync(
  resolve(HERE, "../migrations/0333_user_preferences_home_last_seen.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
/** The baseline's own user_preferences block (CREATE + its ADD COLUMN guards). */
const BASELINE_PREFS = BASELINE.slice(
  BASELINE.indexOf("-- ─── 40. user_preferences"),
  BASELINE.indexOf("-- ─── 41.")
);
/** The same block as a pod that booted before 0333 ran it. */
const PRE_0333 = BASELINE_PREFS.split("\n")
  .filter((l) => !l.includes("home_last_seen_at"))
  .join("\n");
const declared = getTableConfig(userPreferences).columns.map((c) => c.name);

async function columnsOf(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_preferences'`
  );
  return r.rows.map((x) => x.column_name).sort();
}

describe("migration 0333 — user_preferences.home_last_seen_at", () => {
  it("non-vacuity: the schema declares it and the pre-0333 table lacks it", async () => {
    expect(declared).toContain("home_last_seen_at");
    const pg = new PGlite();
    await pg.exec(PRE_0333);
    expect(await columnsOf(pg)).not.toContain("home_last_seen_at");
  });

  it("an existing pod gains the column, idempotently, keeping its rows", async () => {
    const pg = new PGlite();
    await pg.exec(PRE_0333);
    await pg.query(`INSERT INTO user_preferences (user_id) VALUES ('u-1')`);
    await pg.exec(M0333);
    await pg.exec(M0333);
    expect(await columnsOf(pg)).toEqual([...declared].sort());
    const row = await pg.query<{ home_last_seen_at: unknown }>(
      `SELECT home_last_seen_at FROM user_preferences WHERE user_id = 'u-1'`
    );
    expect(row.rows).toEqual([{ home_last_seen_at: null }]);
  });

  it("boot coherence names the column, attributed to the 0333 file", () => {
    const mine = REQUIRED_COLUMNS.filter(
      (c) => c.table === "user_preferences" && c.column === "home_last_seen_at"
    );
    expect(mine.map((c) => c.addedBy)).toEqual([
      "0333_user_preferences_home_last_seen.sql",
    ]);
    expect(M0333).toContain("home_last_seen_at");
  });

  it("a fresh install gets it from the baseline", async () => {
    const pg = new PGlite();
    await pg.exec(BASELINE_PREFS);
    expect(await columnsOf(pg)).toEqual([...declared].sort());
  });
});
