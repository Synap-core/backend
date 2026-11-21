/**
 * REAL-POSTGRES (PGlite) test for migration 0434 — `apps.approved_access`,
 * an app connection's access in its v2 form (app permissions W2, decision
 * 51ad8d1e).
 *
 * PRE-0434 SHAPE: the baseline's own `apps` section with the 0434 line
 * removed — what a pod that booted before 0434 has.
 *
 * Pinned:
 *   - 0434 runs TWICE without error; an existing app keeps its
 *     `approved_requests` and reads `approved_access` NULL (every reader
 *     then lifts its pairs at read time, until the backfill writes v2);
 *   - `apps` ends with exactly the Drizzle columns, upgraded or fresh;
 *   - the boot coherence list names the column, attributed to 0434.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { apps } from "./schema/apps.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0434_FILE = "0434_apps_approved_access.sql";
const M0434 = read(M0434_FILE);
const BASELINE = read("0000_baseline_schema.sql");

/** `apps` references `users`; a one-column stand-in is enough here. */
const USERS = `CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY);`;
const APPS_START = BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "apps"');
const BASELINE_APPS = BASELINE.slice(
  APPS_START,
  BASELINE.indexOf("-- 0319: lifecycle columns", APPS_START)
);

/** The baseline as a pod that booted before 0434 has it. */
function pre0434(): string {
  const apps = BASELINE_APPS.split("\n")
    .filter((l) => !l.includes("0434") && !l.includes('"approved_access"'))
    .join("\n");
  return `${USERS}\n${apps}`;
}

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}
const declared = getTableConfig(apps)
  .columns.map((c) => c.name)
  .sort();

describe("migration 0434 — apps.approved_access", { timeout: 60_000 }, () => {
  it("non-vacuity: the pre-0434 shape lacks the column", async () => {
    const pg = new PGlite();
    await pg.exec(pre0434());
    const cols = await columnsOf(pg, "apps");
    expect(cols).not.toContain("approved_access");
    expect(cols).toContain("approved_requests");
  });

  it("runs twice, keeps existing approvals, and ends with exactly the Drizzle columns", async () => {
    const pg = new PGlite();
    await pg.exec(pre0434());
    await pg.query(
      `INSERT INTO apps (owner_user_id, public_id, name, approved_requests)
       VALUES ('u-1', 'app_1', 'Studio', $1::jsonb)`,
      [
        JSON.stringify([
          {
            permission: "entity.note.read",
            workspaceId: "w-1",
            scope: "space",
          },
        ]),
      ]
    );
    await pg.exec(M0434);
    await pg.exec(M0434);
    const row = await pg.query<{
      approved_requests: unknown;
      approved_access: unknown;
    }>(
      `SELECT approved_requests, approved_access FROM apps WHERE public_id = 'app_1'`
    );
    expect(row.rows[0]?.approved_access).toBeNull();
    expect(row.rows[0]?.approved_requests).toEqual([
      { permission: "entity.note.read", workspaceId: "w-1", scope: "space" },
    ]);
    expect(await columnsOf(pg, "apps")).toEqual(declared);
  });

  it("a fresh install (baseline then 0434) ends in the same shape", async () => {
    const pg = new PGlite();
    await pg.exec(`${USERS}\n${BASELINE_APPS}`);
    await pg.exec(M0434);
    expect(await columnsOf(pg, "apps")).toEqual(declared);
  });

  it("the boot coherence list names the column, attributed to 0434", () => {
    expect(
      REQUIRED_COLUMNS.filter((r) => r.addedBy === M0434_FILE).map(
        (r) => `${r.table}.${r.column}`
      )
    ).toEqual(["apps.approved_access"]);
  });
});
