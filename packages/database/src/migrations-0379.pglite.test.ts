/**
 * REAL-POSTGRES (PGlite) test for migration 0379 — the permissions a pod
 * app asks for POD-WIDE (`oauth_clients.requested_pod_wide`).
 *
 * PRE-0379 SHAPE: the baseline's oauth block with the 0379 lines removed —
 * what a pod that booted before 0379 has.
 *
 * Pinned:
 *   - 0379 runs TWICE without error; an existing DCR row and an existing
 *     cached document read `requested_pod_wide` '{}' (an empty array);
 *   - `oauth_clients` ends with exactly the Drizzle columns, on an upgraded
 *     pod and on a fresh install (baseline, then 0379);
 *   - the boot coherence list names the column, attributed to 0379.
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
const M0379_FILE = "0379_oauth_client_requested_pod_wide.sql";
const M0379 = read(M0379_FILE);
const BASELINE = read("0000_baseline_schema.sql");
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** The oauth block as a pod that booted before 0379 has it. */
const PRE_0379 = BASELINE_OAUTH.split("\n")
  .filter((l) => !l.includes("0379") && !l.includes('"requested_pod_wide"'))
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
  "migration 0379 — pod app pod-wide read requests",
  { timeout: 60_000 },
  () => {
    it("non-vacuity: the pre-0379 shape lacks the column, and the baseline has it", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0379);
      const cols = await columnsOf(pg, "oauth_clients");
      expect(cols).not.toContain("requested_pod_wide");
      expect(cols).toContain("requested_reasons");
      expect(BASELINE_OAUTH).toContain('"requested_pod_wide"');
    });

    it("runs twice, keeps existing rows (they read '{}'), and ends with exactly the Drizzle columns", async () => {
      const pg = new PGlite();
      await pg.exec(PRE_0379);
      await pg.query(
        `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES
         ('dcr_x', 'Claude', 'dcr'),
         ('https://studio.example.com/.well-known/synap-client.json', 'Studio', 'cimd')`
      );
      await pg.exec(M0379);
      await pg.exec(M0379);
      const rows = await pg.query<{ requested_pod_wide: unknown }>(
        `SELECT requested_pod_wide FROM oauth_clients ORDER BY client_id`
      );
      expect(rows.rows.map((r) => r.requested_pod_wide)).toEqual([[], []]);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("a fresh install (baseline then 0379) ends in the same shape", async () => {
      const pg = new PGlite();
      await pg.exec(BASELINE_OAUTH);
      await pg.exec(M0379);
      expect(await columnsOf(pg, "oauth_clients")).toEqual(declared);
    });

    it("the boot coherence list names the column, attributed to 0379", () => {
      expect(
        REQUIRED_COLUMNS.filter((r) => r.addedBy === M0379_FILE).map(
          (r) => `${r.table}.${r.column}`
        )
      ).toEqual(["oauth_clients.requested_pod_wide"]);
    });
  }
);
