/**
 * REAL-POSTGRES (PGlite) test for migration 0339b — a pod app's reason for
 * each permission (`oauth_clients.requested_reasons`).
 *
 * PRE-0339b SHAPE: the baseline's oauth block with the 0339b lines removed —
 * what a pod that booted before 0339b has.
 *
 * Pinned:
 *   - 0339b runs TWICE without error; an existing DCR row and an existing
 *     cached document read `requested_reasons` '{}';
 *   - `oauth_clients` ends with exactly the Drizzle columns, on an upgraded
 *     pod and on a fresh install (baseline, then 0339b);
 *   - the boot coherence list names the column, attributed to 0339b.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { oauthClients } from "./schema/pod-oauth.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0339B_FILE = "0339b_oauth_client_request_reasons.sql";
const M0339B = read(M0339B_FILE);
const BASELINE = read("0000_baseline_schema.sql");
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** The oauth block as a pod that booted before 0339b has it. */
const PRE_0339B = BASELINE_OAUTH.split("\n")
  .filter((l) => !l.includes("0339b") && !l.includes('"requested_reasons"'))
  .join("\n");

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}
const declared = getTableConfig(oauthClients)
  .columns.map((c) => c.name)
  .sort();

describe("migration 0339b — pod app permission reasons", { timeout: 60_000 }, () => {
  it("non-vacuity: the pre-0339b shape lacks the column, and the baseline has it", async () => {
    const pg = new PGlite();
    await pg.exec(PRE_0339B);
    const cols = await columnsOf(pg, "oauth_clients");
    expect(cols).not.toContain("requested_reasons");
    expect(cols).toContain("requested_templates");
    expect(BASELINE_OAUTH).toContain('"requested_reasons"');
  });

  it("runs twice, keeps existing rows (they read '{}'), and ends with exactly the Drizzle columns", async () => {
    const pg = new PGlite();
    await pg.exec(PRE_0339B);
    await pg.query(
      `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES
         ('dcr_x', 'Claude', 'dcr'),
         ('https://studio.example.com/.well-known/synap-client.json', 'Studio', 'cimd')`
    );
    await pg.exec(M0339B);
    await pg.exec(M0339B);
    const rows = await pg.query<{ requested_reasons: unknown }>(
      `SELECT requested_reasons FROM oauth_clients ORDER BY client_id`
    );
    expect(rows.rows.map((r) => r.requested_reasons)).toEqual([{}, {}]);
    expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
  });

  it("a fresh install (baseline then 0339b) ends in the same shape", async () => {
    const pg = new PGlite();
    await pg.exec(BASELINE_OAUTH);
    await pg.exec(M0339B);
    expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
  });

  it("the boot coherence list names the column, attributed to 0339b", () => {
    expect(
      REQUIRED_COLUMNS.filter((r) => r.addedBy === M0339B_FILE).map(
        (r) => `${r.table}.${r.column}`
      )
    ).toEqual(["oauth_clients.requested_reasons"]);
  });
});
