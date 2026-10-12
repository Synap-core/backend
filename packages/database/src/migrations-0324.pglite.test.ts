/**
 * REAL-POSTGRES (PGlite) test for migration 0324 — the lifecycle transition
 * outbox (review D8). The migration and the baseline create the table with
 * EVERY column the drizzle schema declares (the outbox code reads and writes
 * through drizzle), and re-running is a no-op.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { lifecycleTransitionOutbox } from "./schema/lifecycle-transition-outbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0324 = readFileSync(
  resolve(HERE, "../migrations/0324_lifecycle_transition_outbox.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
const declared = getTableConfig(lifecycleTransitionOutbox).columns.map(
  (c) => c.name
);

describe("migration 0324 — lifecycle_transition_outbox", () => {
  it("creates every declared column, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(M0324);
    await pg.exec(M0324);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lifecycle_transition_outbox'`
    );
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      [...declared].sort()
    );
    await pg.close();
  }, 60_000);

  it("the baseline carries the same table", () => {
    const create = M0324.slice(M0324.indexOf("CREATE TABLE"));
    expect(BASELINE).toContain(create.trim());
  });
});
