/**
 * REAL-POSTGRES (PGlite) test for migration 0396 — where a pod app opens
 * one of its objects (`oauth_clients.open_uri`, `synap_open_uri`).
 *
 * PRE-0396 SHAPE: the baseline's oauth block with the 0396 lines removed —
 * what a pod that booted before 0396 has.
 *
 * Pinned:
 *   - 0396 runs TWICE without error; an existing DCR row and an existing
 *     cached document read `open_uri` NULL (filled at the next refresh);
 *   - `oauth_clients` ends with exactly the Drizzle columns, on an upgraded
 *     pod and on a fresh install (baseline, then 0396);
 *   - the boot coherence list names the column, attributed to 0396.
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
const M0396_FILE = "0396_oauth_client_open_uri.sql";
const M0396 = read(M0396_FILE);
const BASELINE = read("0000_baseline_schema.sql");
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** The oauth block as a pod that booted before 0396 has it. */
const PRE_0396 = BASELINE_OAUTH.split("\n")
  .filter((l) => !l.includes("0396") && !l.includes('"open_uri"'))
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
  "migration 0396 — where a pod app opens an object",
  { timeout: 60_000 },
  () => {
    it("non-vacuity: the pre-0396 shape lacks the column, and the baseline has it", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0396);
      const cols = await columnsOf(pg, "oauth_clients");
      expect(cols).not.toContain("open_uri");
      expect(cols).toContain("requested_reasons");
      expect(BASELINE_OAUTH).toContain('"open_uri"');
    });

    it("runs twice, keeps existing rows (they read NULL), and ends with exactly the Drizzle columns", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0396);
      await pg.query(
        `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES
         ('dcr_x', 'Claude', 'dcr'),
         ('https://studio.example.com/.well-known/synap-client.json', 'Studio', 'cimd')`
      );
      await pg.exec(M0396);
      await pg.exec(M0396);
      const rows = await pg.query<{ open_uri: unknown }>(
        `SELECT open_uri FROM oauth_clients ORDER BY client_id`
      );
      expect(rows.rows.map((r) => r.open_uri)).toEqual([null, null]);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("a fresh install (baseline then 0396) ends in the same shape", async () => {
      const pg = new PGlite();
      await pg.exec(BASELINE_OAUTH);
      await pg.exec(M0396);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("the boot coherence list names the column, attributed to 0396", () => {
      expect(
        REQUIRED_COLUMNS.filter((r) => r.addedBy === M0396_FILE).map(
          (r) => `${r.table}.${r.column}`
        )
      ).toEqual(["oauth_clients.open_uri"]);
    });
  }
);
