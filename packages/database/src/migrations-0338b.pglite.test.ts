/**
 * REAL-POSTGRES (PGlite) test for migration 0338b — pod app sign-in, apps part
 * (spec 17 §8.2, wave PB2).
 *
 * PRE-0338b SHAPE: the baseline's own oauth and apps blocks with the 0338b
 * lines removed, then 0338 run on them: what a pod that booted after PB1 and
 * before PB2 has. `users` is a one-column stand-in (the apps block references
 * it).
 *
 * Pinned:
 *   - 0338b runs TWICE without error; an App Connect app and an MCP code keep
 *     their rows; a legacy free-string `mode` reads 'specific';
 *   - the columns it adds equal the Drizzle tables, the baseline guards each,
 *     and the boot coherence list names each, attributed to 0338b;
 *   - `mode` is 'specific' or 'oauth', and 'oauth' iff `oauth_client_id`;
 *   - one connection per (owner, oauth_client_id);
 *   - a code's `app_id` names a real app, and deleting the app deletes it;
 *   - a fresh install (baseline, 0338, 0338b) ends in the same shape.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { apps } from "./schema/apps.js";
import { oauthAuthorizationCodes, oauthClients } from "./schema/pod-oauth.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0338B_FILE = "0338b_pod_app_oauth_apps.sql";
const M0338B = read(M0338B_FILE);
const M0338 = read("0338_pod_app_oauth.sql");
const BASELINE = read("0000_baseline_schema.sql");

const slice = (from: string, to: string) =>
  BASELINE.slice(BASELINE.indexOf(from), BASELINE.indexOf(to));
const BASELINE_OAUTH = slice(
  "-- oauth_clients / oauth_authorization_codes",
  "-- ─── 3. events"
);
const BASELINE_APPS = slice("-- apps (0309)", "-- 0319: lifecycle columns");
const USERS_STUB = `CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY);`;

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
const ADDED = addedColumns(M0338B);
const ADDED_NAMES = new Set(ADDED.map((a) => a.column));

/** A baseline block as a pod that booted before 0338b ran it. */
const before0338b = (block: string) => {
  const lines = block.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.includes("0338b")) continue;
    if ([...ADDED_NAMES].some((c) => l.includes(`"${c}"`))) continue;
    // The unique index statement spans three lines.
    if (l.includes("apps_owner_oauth_client_uidx")) {
      i += 2;
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
};

const OWNER = "u-owner";
const OTHER = "u-other";
const CIMD_ID = "https://studio.example.com/.well-known/synap-client.json";

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}

async function pre0338b(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(USERS_STUB);
  await pg.exec(before0338b(BASELINE_OAUTH));
  await pg.exec(M0338);
  await pg.exec(before0338b(BASELINE_APPS));
  await pg.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [OWNER, OTHER]);
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

const insertApp = (
  pg: PGlite,
  v: { owner?: string; name: string; mode?: string; client?: string | null }
) =>
  pg.query<{ id: string }>(
    `INSERT INTO apps (owner_user_id, public_id, name, mode, oauth_client_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      v.owner ?? OWNER,
      `app_${v.name.toLowerCase().replace(/\W/g, "")}_${Math.random()}`,
      v.name,
      v.mode ?? "specific",
      v.client ?? null,
    ]
  );

const insertCode = (pg: PGlite, hash: string, appId: string | null) =>
  pg.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, app_id)
     VALUES ($1, $2, $3, 'https://studio.example.com/cb', 'c', now() + interval '10 minutes', $4)`,
    [hash, CIMD_ID, OWNER, appId]
  );

describe("migration 0338b — pod app connections", { timeout: 60_000 }, () => {
  it("non-vacuity: it adds exactly apps.oauth_client_id, codes.app_id, clients.requested_templates", async () => {
    expect(ADDED.map((a) => `${a.table}.${a.column}`).sort()).toEqual(
      [
        "apps.oauth_client_id",
        "oauth_authorization_codes.app_id",
        "oauth_clients.requested_templates",
      ].sort()
    );
    const pg = await pre0338b();
    for (const a of ADDED) {
      expect(await columnsOf(pg, a.table)).not.toContain(a.column);
    }
  });

  it("runs twice, keeps existing rows, normalizes a legacy mode, ends with the Drizzle columns", async () => {
    const pg = await pre0338b();
    // Before 0338b there is no CHECK: the Hub door once stored any string.
    await pg.query(
      `INSERT INTO apps (owner_user_id, public_id, name, mode) VALUES ($1, 'app_a', 'CLI app', 'specific'), ($1, 'app_b', 'Legacy', 'custom')`,
      [OWNER]
    );
    await pg.query(
      `INSERT INTO oauth_clients (client_id, client_name) VALUES ('dcr_x', 'Claude')`
    );
    await pg.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
       VALUES ('h1', 'dcr_x', $1, 'https://claude.ai/cb', 'c', now() + interval '10 minutes')`,
      [OWNER]
    );

    await pg.exec(M0338B);
    await pg.exec(M0338B);

    const rows = await pg.query<{
      name: string;
      mode: string;
      oauth_client_id: string | null;
    }>(`SELECT name, mode, oauth_client_id FROM apps ORDER BY name`);
    expect(rows.rows).toEqual([
      { name: "CLI app", mode: "specific", oauth_client_id: null },
      { name: "Legacy", mode: "specific", oauth_client_id: null },
    ]);
    const code = await pg.query<{ app_id: string | null }>(
      `SELECT app_id FROM oauth_authorization_codes WHERE code_hash = 'h1'`
    );
    expect(code.rows[0]?.app_id).toBeNull();
    const client = await pg.query<{ requested_templates: string[] }>(
      `SELECT requested_templates FROM oauth_clients WHERE client_id = 'dcr_x'`
    );
    expect(client.rows[0]?.requested_templates).toEqual([]);

    expect(await columnsOf(pg, "apps")).toEqual(declared(apps));
    expect(await columnsOf(pg, "oauth_clients")).toEqual(
      declared(oauthClients)
    );
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
  });

  it("mode is 'specific' or 'oauth', and 'oauth' exactly when oauth_client_id is set", async () => {
    const pg = await pre0338b();
    await pg.exec(M0338B);
    expect(
      await sqlState(insertApp(pg, { name: "S", mode: "specific" }))
    ).toBeNull();
    expect(
      await sqlState(
        insertApp(pg, { name: "O", mode: "oauth", client: CIMD_ID })
      )
    ).toBeNull();
    expect(await sqlState(insertApp(pg, { name: "O2", mode: "oauth" }))).toBe(
      "23514"
    );
    expect(
      await sqlState(
        insertApp(pg, { name: "S2", mode: "specific", client: CIMD_ID })
      )
    ).toBe("23514");
    expect(await sqlState(insertApp(pg, { name: "X", mode: "custom" }))).toBe(
      "23514"
    );
  });

  it("one connection per (owner, app); the same app for another owner is a second row", async () => {
    const pg = await pre0338b();
    await pg.exec(M0338B);
    await insertApp(pg, { name: "Studio A", mode: "oauth", client: CIMD_ID });
    expect(
      await sqlState(
        insertApp(pg, { name: "Studio B", mode: "oauth", client: CIMD_ID })
      )
    ).toBe("23505");
    expect(
      await sqlState(
        insertApp(pg, {
          owner: OTHER,
          name: "Studio A",
          mode: "oauth",
          client: CIMD_ID,
        })
      )
    ).toBeNull();
    // App Connect rows (no client id) are not caught by the partial index.
    expect(await sqlState(insertApp(pg, { name: "One" }))).toBeNull();
    expect(await sqlState(insertApp(pg, { name: "Two" }))).toBeNull();
  });

  it("a code's app_id names a real app, and deleting the app deletes its codes", async () => {
    const pg = await pre0338b();
    await pg.exec(M0338B);
    const {
      rows: [app],
    } = await insertApp(pg, { name: "Studio", mode: "oauth", client: CIMD_ID });
    expect(
      await sqlState(
        insertCode(pg, "ghost", "00000000-0000-4000-8000-000000000000")
      )
    ).toBe("23503");
    expect(await sqlState(insertCode(pg, "real", app!.id))).toBeNull();
    await pg.query(`DELETE FROM apps WHERE id = $1`, [app!.id]);
    const left = await pg.query(
      `SELECT 1 FROM oauth_authorization_codes WHERE code_hash = 'real'`
    );
    expect(left.rows).toEqual([]);
  });

  it("a fresh install (baseline, 0338, 0338b) ends in the same shape, with the CHECK and the key", async () => {
    const pg = new PGlite();
    await pg.exec(USERS_STUB);
    await pg.exec(BASELINE_OAUTH);
    await pg.exec(M0338);
    await pg.exec(BASELINE_APPS);
    await pg.exec(M0338B);
    expect(await columnsOf(pg, "apps")).toEqual(declared(apps));
    expect(await columnsOf(pg, "oauth_clients")).toEqual(
      declared(oauthClients)
    );
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
    const constraints = await pg.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('apps_mode_check', 'oauth_authorization_codes_app_id_fkey') ORDER BY conname`
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual([
      "apps_mode_check",
      "oauth_authorization_codes_app_id_fkey",
    ]);
    const index = await pg.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'apps_owner_oauth_client_uidx'`
    );
    expect(index.rows).toHaveLength(1);
  });

  it("the baseline guards every added column and the boot list names each, attributed to 0338b", () => {
    for (const a of ADDED) {
      expect(BASELINE).toContain(
        `ALTER TABLE "${a.table}" ADD COLUMN IF NOT EXISTS "${a.column}"`
      );
    }
    const required = REQUIRED_COLUMNS.filter(
      (r) => r.addedBy === M0338B_FILE
    ).map((r) => `${r.table}.${r.column}`);
    expect(required.sort()).toEqual(
      [
        "apps.oauth_client_id",
        "oauth_authorization_codes.app_id",
        "oauth_clients.requested_templates",
      ].sort()
    );
  });
});
