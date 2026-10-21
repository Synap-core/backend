/**
 * REAL-POSTGRES (PGlite) test for migration 0338 — pod app sign-in, OAuth
 * clients part (spec 17 §8.2, wave PB1).
 *
 * PRE-0338 SHAPE: the baseline's own oauth block (CREATE + ADD COLUMN guards)
 * with the 0338 lines removed, i.e. what a pod that booted before 0338 has.
 *
 * Pinned:
 *   - 0338 runs TWICE without error; an existing (DCR) client keeps its row and
 *     reads as 'dcr'; an existing code keeps its row with resource NULL;
 *   - the columns it adds equal the Drizzle tables and the baseline and the boot
 *     coherence list name the load-bearing ones, attributed to 0338;
 *   - `client_kind` is 'dcr' or 'cimd', nothing else;
 *   - a fresh install (baseline, then 0338) ends in the same shape.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { oauthAuthorizationCodes, oauthClients } from "./schema/pod-oauth.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0338_FILE = "0338_pod_app_oauth.sql";
const M0338 = read(M0338_FILE);
const BASELINE = read("0000_baseline_schema.sql");

/** The baseline's own oauth block (both tables, CREATE + guards). */
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c"` pairs in a SQL text. */
function addedColumns(
  sqlText: string
): Array<{ table: string; column: string }> {
  const re =
    /ALTER TABLE "([a-z0-9_]+)" ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"/g;
  return Array.from(sqlText.matchAll(re), (m) => ({
    table: m[1]!,
    column: m[2]!,
  }));
}
const ADDED = addedColumns(M0338);
const ADDED_NAMES = new Set(ADDED.map((a) => a.column));

/** The same block as a pod that booted before 0338 ran it. */
const PRE_0338 = BASELINE_OAUTH.split("\n")
  .filter(
    (l) =>
      !l.includes("0338") &&
      !l.includes("it runs after this file") &&
      ![...ADDED_NAMES].some((c) => l.includes(`"${c}"`))
  )
  .join("\n");

const DCR_ID = "dcr_existing";
const CIMD_ID = "https://studio.example.com/.well-known/synap-client.json";

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}

async function pre0338(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(PRE_0338);
  return pg;
}

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const declared = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t)
    .columns.map((c) => c.name)
    .sort();

describe("migration 0338 — pod app OAuth clients", { timeout: 60_000 }, () => {
  it("non-vacuity: it adds exactly the CIMD columns + codes.resource, absent before", async () => {
    expect(ADDED.map((a) => `${a.table}.${a.column}`).sort()).toEqual(
      [
        "oauth_authorization_codes.resource",
        "oauth_clients.client_kind",
        "oauth_clients.client_uri",
        "oauth_clients.initiate_login_uri",
        "oauth_clients.metadata_expires_at",
        "oauth_clients.metadata_fetched_at",
        "oauth_clients.metadata_sha256",
        "oauth_clients.requested_permissions",
      ].sort()
    );
    const pg = await pre0338();
    const before = [
      ...(await columnsOf(pg, "oauth_clients")),
      ...(await columnsOf(pg, "oauth_authorization_codes")),
    ];
    for (const a of ADDED) expect(before).not.toContain(a.column);
  });

  it("runs twice, keeps existing rows, and ends with exactly the Drizzle columns", async () => {
    const pg = await pre0338();
    await pg.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, scopes)
       VALUES ($1, 'Claude', ARRAY['https://claude.ai/api/mcp/auth_callback'], ARRAY['mcp.read'])`,
      [DCR_ID]
    );
    await pg.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
       VALUES ('h1', $1, 'u-1', 'https://claude.ai/cb', 'c', now() + interval '10 minutes')`,
      [DCR_ID]
    );

    await pg.exec(M0338);
    await pg.exec(M0338);

    const client = await pg.query<{
      client_kind: string;
      requested_permissions: string[];
      metadata_fetched_at: string | null;
    }>(
      `SELECT client_kind, requested_permissions, metadata_fetched_at FROM oauth_clients WHERE client_id = $1`,
      [DCR_ID]
    );
    expect(client.rows[0]).toEqual({
      client_kind: "dcr",
      requested_permissions: [],
      metadata_fetched_at: null,
    });
    const code = await pg.query<{ resource: string | null }>(
      `SELECT resource FROM oauth_authorization_codes WHERE code_hash = 'h1'`
    );
    expect(code.rows[0]?.resource).toBeNull();

    expect(await columnsOf(pg, "oauth_clients")).toEqual(
      declared(oauthClients)
    );
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
  });

  it("a fresh install (baseline then 0338) ends in the same shape", async () => {
    const pg = new PGlite();
    await pg.exec(BASELINE_OAUTH);
    await pg.exec(M0338);
    expect(await columnsOf(pg, "oauth_clients")).toEqual(
      declared(oauthClients)
    );
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
  });

  it("client_kind is 'dcr' or 'cimd' and nothing else", async () => {
    const pg = await pre0338();
    await pg.exec(M0338);
    expect(
      await sqlState(
        pg.query(
          `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES ($1, 'Studio', 'cimd')`,
          [CIMD_ID]
        )
      )
    ).toBeNull();
    expect(
      await sqlState(
        pg.query(
          `INSERT INTO oauth_clients (client_id, client_name, client_kind) VALUES ('x', 'X', 'jwt')`
        )
      )
    ).toBe("23514");
  });

  it("the baseline guards every added column and the boot list names the load-bearing ones", () => {
    for (const a of ADDED) {
      expect(BASELINE).toContain(
        `ALTER TABLE "${a.table}" ADD COLUMN IF NOT EXISTS "${a.column}"`
      );
    }
    const required = REQUIRED_COLUMNS.filter(
      (r) => r.addedBy === M0338_FILE
    ).map((r) => `${r.table}.${r.column}`);
    expect(required.sort()).toEqual(
      [
        "oauth_authorization_codes.resource",
        "oauth_clients.client_kind",
        "oauth_clients.metadata_expires_at",
        "oauth_clients.metadata_fetched_at",
        "oauth_clients.requested_permissions",
      ].sort()
    );
  });
});
