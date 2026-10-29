/**
 * REAL-POSTGRES (PGlite) test for migration 0376 — the status watcher's
 * episode claims (status-flow W6): the migration and the baseline create the
 * table with every column the drizzle schema declares, idempotently; an
 * episode is claimed once (a second claim of the same tuple, even in one
 * batch, is left out); a released claim is claimable again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { statusSignalRaised } from "./schema/status-signal-raised.js";
import {
  claimStatusSignals,
  releaseStatusSignal,
} from "./services/lifecycle/status-signals.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0376 = read("0376_status_signal_raised.sql");
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(M0376);
  await pg.exec(M0376);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'status_signal_raised'`
    )
  ).rows.map((r) => r.column_name);

describe("migration 0376 — status signal claims", () => {
  it("creates every column the schema declares, and so does the baseline", async () => {
    const declared = getTableConfig(statusSignalRaised).columns.map(
      (c) => c.name
    );
    expect((await columns(pg)).sort()).toEqual([...declared].sort());
    const base = new PGlite();
    const block = BASELINE.slice(BASELINE.indexOf("-- 0376"));
    await base.exec(block);
    expect((await columns(base)).sort()).toEqual([...declared].sort());
    await base.close();
  });

  it("claims an episode once; a released one is claimable again", async () => {
    const db = drizzle(pg) as never;
    const late = {
      subjectType: "entity",
      subjectId: "e1",
      signal: "late",
      episodeKey: "a",
    };
    const stuck = { ...late, signal: "stuck" };
    expect(await claimStatusSignals(db, [late, late, stuck])).toHaveLength(2);
    expect(await claimStatusSignals(db, [late, stuck])).toEqual([]);
    expect(
      await claimStatusSignals(db, [{ ...late, episodeKey: "b" }])
    ).toHaveLength(1);
    await releaseStatusSignal(db, late);
    expect(await claimStatusSignals(db, [late])).toEqual([late]);
  });
});
