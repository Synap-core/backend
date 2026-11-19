/**
 * REAL-POSTGRES (PGlite) test for migration 0437 — the kinds grouping of a
 * pod app's requests (`oauth_clients.requested_kind_groups`, decision
 * 51ad8d1e F4).
 *
 * PRE-0437 SHAPE: the baseline's oauth block with the 0437 lines removed —
 * what a pod that booted before 0437 has.
 *
 * Pinned:
 *   - 0437 runs TWICE without error; an existing DCR row and an existing
 *     cached document read `requested_kind_groups` '[]' (an empty array: the
 *     consent then shows their kinds one per row, as before);
 *   - `oauth_clients` ends with exactly the Drizzle columns, on an upgraded
 *     pod and on a fresh install (baseline, then 0437);
 *   - the boot coherence list names the column, attributed to 0437.
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
const M0437_FILE = "0437_oauth_client_requested_kind_groups.sql";
const M0437 = read(M0437_FILE);
const BASELINE = read("0000_baseline_schema.sql");
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** The oauth block as a pod that booted before 0437 has it. */
const PRE_0437 = BASELINE_OAUTH.split("\n")
  .filter((l) => !l.includes("0437") && !l.includes('"requested_kind_groups"'))
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

describe(
  "migration 0437 — the kinds grouping of a pod app's requests",
  { timeout: 60_000 },
  () => {
    it("non-vacuity: the pre-0437 shape lacks the column, and the baseline has it", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0437);
      const cols = await columnsOf(pg, "oauth_clients");
      expect(cols).not.toContain("requested_kind_groups");
      expect(cols).toContain("requested_pod_wide");
      expect(BASELINE_OAUTH).toContain('"requested_kind_groups"');
    });

    it("runs twice, keeps existing rows (they read '[]'), and ends with exactly the Drizzle columns", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0437);
      await pg.query(
        `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES
         ('dcr_x', 'Claude', 'dcr'),
         ('https://studio.example.com/.well-known/synap-client.json', 'Studio', 'cimd')`
      );
      await pg.exec(M0437);
      await pg.exec(M0437);
      const rows = await pg.query<{ requested_kind_groups: unknown }>(
        `SELECT requested_kind_groups FROM oauth_clients ORDER BY client_id`
      );
      expect(rows.rows.map((r) => r.requested_kind_groups)).toEqual([[], []]);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("a fresh install (baseline then 0437) ends in the same shape", async () => {
      const pg = new PGlite();
      await pg.exec(BASELINE_OAUTH);
      await pg.exec(M0437);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("the boot coherence list names the column, attributed to 0437", () => {
      expect(
        REQUIRED_COLUMNS.filter((r) => r.addedBy === M0437_FILE).map(
          (r) => `${r.table}.${r.column}`
        )
      ).toEqual(["oauth_clients.requested_kind_groups"]);
    });
  }
);
