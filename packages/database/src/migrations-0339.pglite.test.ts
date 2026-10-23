/**
 * REAL-POSTGRES (PGlite) test for migration 0339 — pod app refresh tokens
 * (spec 17 §8.3, wave PB3).
 *
 * PRE-0339 SHAPE: the baseline's own oauth and apps blocks, then 0338 and
 * 0338b run on them: what a pod that booted after PB2 has. `users` is a
 * one-column stand-in (the apps block references it).
 *
 * Pinned:
 *   - 0339 runs TWICE without error and creates exactly the Drizzle table;
 *   - the baseline creates the same table (a fresh install, which then runs
 *     0339 as a no-op) and the boot coherence list names it, attributed to
 *     0339;
 *   - a token hash is unique; a token names a real app, and deleting the app
 *     (the connection) deletes its tokens;
 *   - the app and family indexes the revoke / sweep paths read exist.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { oauthRefreshTokens } from "./schema/pod-oauth.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0339_FILE = "0339_oauth_refresh_tokens.sql";
const M0339 = read(M0339_FILE);
const M0338 = read("0338_pod_app_oauth.sql");
const M0338B = read("0338b_pod_app_oauth_apps.sql");
const BASELINE = read("0000_baseline_schema.sql");

const slice = (from: string, to: string) =>
  BASELINE.slice(BASELINE.indexOf(from), BASELINE.indexOf(to));
const BASELINE_OAUTH = slice(
  "-- oauth_clients / oauth_authorization_codes",
  "-- ─── 3. events"
);
const BASELINE_APPS = slice("-- apps (0309)", "-- 0319: lifecycle columns");
/**
 * Where a NEWER baseline block (0341+) starts, so a slice "from 0339 onward"
 * stops before tables later migrations append (they reference tables this
 * PGlite fixture never creates). End of file when there is none.
 */
const NEWER_BLOCK = (() => {
  const i = BASELINE.search(/\n-- 03(4[1-9]|[5-9][0-9]):/);
  return i === -1 ? undefined : i + 1;
})();
/** The baseline's own 0339 block (and 0340's): from its comment to the next block. */
const BASELINE_REFRESH = BASELINE.slice(
  BASELINE.indexOf("-- 0339: a pod app's rotating"),
  NEWER_BLOCK
);
const USERS_STUB = `CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY);`;

const OWNER = "u-owner";
const CIMD_ID = "https://studio.example.com/.well-known/synap-client.json";

async function pre0339(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(USERS_STUB);
  await pg.exec(BASELINE_OAUTH);
  await pg.exec(M0338);
  await pg.exec(BASELINE_APPS);
  await pg.exec(M0338B);
  await pg.query(`INSERT INTO users (id) VALUES ($1)`, [OWNER]);
  return pg;
}

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const DECLARED = getTableConfig(oauthRefreshTokens)
  .columns.map((c) => c.name)
  .sort();
/**
 * What 0339 ALONE creates: the Drizzle table minus the columns a LATER
 * migration adds (derived from the boot coherence list, e.g. 0340's
 * `device_id`), so a later column never reads as 0339's.
 */
const ADDED_LATER = new Set(
  REQUIRED_COLUMNS.filter(
    (r) => r.table === "oauth_refresh_tokens" && r.addedBy > M0339_FILE
  ).map((r) => r.column)
);
const DECLARED_0339 = DECLARED.filter((c) => !ADDED_LATER.has(c));

const insertApp = (pg: PGlite) =>
  pg.query<{ id: string }>(
    `INSERT INTO apps (owner_user_id, public_id, name, mode, oauth_client_id)
     VALUES ($1, $2, 'Studio', 'oauth', $3) RETURNING id`,
    [OWNER, `app_${randomUUID()}`, CIMD_ID]
  );

const insertToken = (pg: PGlite, hash: string, appId: string) =>
  pg.query(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, family_id, client_id, user_id, app_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [hash, randomUUID(), CIMD_ID, OWNER, appId]
  );

describe("migration 0339 — oauth_refresh_tokens", { timeout: 60_000 }, () => {
  it("non-vacuity: a post-PB2 pod has no refresh token table", async () => {
    const pg = await pre0339();
    expect(await columnsOf(pg, "oauth_refresh_tokens")).toEqual([]);
  });

  it("runs twice, keeps rows, and ends with exactly the Drizzle columns", async () => {
    const pg = await pre0339();
    await pg.exec(M0339);
    const {
      rows: [app],
    } = await insertApp(pg);
    await insertToken(pg, "h1", app!.id);
    await pg.exec(M0339);
    expect(await columnsOf(pg, "oauth_refresh_tokens")).toEqual(DECLARED_0339);
    const kept = await pg.query(`SELECT 1 FROM oauth_refresh_tokens`);
    expect(kept.rows).toHaveLength(1);
  });

  it("a token hash is unique; a token names a real app; deleting the app deletes its tokens", async () => {
    const pg = await pre0339();
    await pg.exec(M0339);
    const {
      rows: [app],
    } = await insertApp(pg);
    expect(await sqlState(insertToken(pg, "h1", app!.id))).toBeNull();
    expect(await sqlState(insertToken(pg, "h1", app!.id))).toBe("23505");
    expect(
      await sqlState(
        insertToken(pg, "ghost", "00000000-0000-4000-8000-000000000000")
      )
    ).toBe("23503");
    await pg.query(`DELETE FROM apps WHERE id = $1`, [app!.id]);
    const left = await pg.query(`SELECT 1 FROM oauth_refresh_tokens`);
    expect(left.rows).toEqual([]);
  });

  it("the indexes the revoke and sweep paths read exist", async () => {
    const pg = await pre0339();
    await pg.exec(M0339);
    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'oauth_refresh_tokens' ORDER BY indexname`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      "oauth_refresh_tokens_app_idx",
      "oauth_refresh_tokens_family_idx",
      "oauth_refresh_tokens_pkey",
      "oauth_refresh_tokens_token_hash_uidx",
    ]);
  });

  it("a fresh install (baseline block, then 0339) ends in the same shape", async () => {
    const pg = new PGlite();
    await pg.exec(USERS_STUB);
    await pg.exec(BASELINE_OAUTH);
    await pg.exec(M0338);
    await pg.exec(BASELINE_APPS);
    await pg.exec(M0338B);
    expect(BASELINE_REFRESH).toContain(
      `CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens"`
    );
    await pg.exec(BASELINE_REFRESH);
    expect(await columnsOf(pg, "oauth_refresh_tokens")).toEqual(DECLARED);
    await pg.exec(M0339);
    expect(await columnsOf(pg, "oauth_refresh_tokens")).toEqual(DECLARED);
    const {
      rows: [app],
    } = await insertApp(pg);
    await insertToken(pg, "h1", app!.id);
    await pg.query(`DELETE FROM apps WHERE id = $1`, [app!.id]);
    expect((await pg.query(`SELECT 1 FROM oauth_refresh_tokens`)).rows).toEqual(
      []
    );
  });

  it("the boot coherence list names the table, attributed to 0339", () => {
    const required = REQUIRED_COLUMNS.filter((r) => r.addedBy === M0339_FILE);
    expect(required.length).toBeGreaterThan(0);
    for (const r of required) {
      expect(r.table).toBe("oauth_refresh_tokens");
      expect(DECLARED).toContain(r.column);
    }
  });
});
