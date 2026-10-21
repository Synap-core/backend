/**
 * REAL-POSTGRES (PGlite) test for migration 0339 — "Sign in with Synap"
 * (founder A1, 2026-10-20): `apps.redirect_uris` and
 * `oauth_authorization_codes.app_grant`.
 *
 * PRE-0339 SHAPE: the baseline's own `apps` table and oauth block with the
 * 0339 lines removed — what a pod that booted before 0339 has.
 *
 * Pinned:
 *   - 0339 runs TWICE without error; an existing app reads `redirect_uris`
 *     '{}' (it signs no one in until its owner says where), an existing code
 *     reads `app_grant` NULL;
 *   - both tables end with exactly the Drizzle columns, on an upgraded pod and
 *     on a fresh install (baseline, then 0339);
 *   - the boot coherence list names both columns, attributed to 0339.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { oauthAuthorizationCodes } from "./schema/pod-oauth.js";
import { apps } from "./schema/apps.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0339_FILE = "0339_app_person_sign_in.sql";
const M0339 = read(M0339_FILE);
const BASELINE = read("0000_baseline_schema.sql");

/** `apps` references `users`; a one-column stand-in is enough here. */
const USERS = `CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY);`;
const BASELINE_APPS = BASELINE.slice(
  BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "apps"'),
  BASELINE.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "apps_owner_name_unique"')
);
const BASELINE_OAUTH = BASELINE.slice(
  BASELINE.indexOf("-- oauth_clients / oauth_authorization_codes"),
  BASELINE.indexOf("-- ─── 3. events")
);

/** The baseline as a pod that booted before 0339 has it. */
function pre0339(): string {
  const apps = BASELINE_APPS.replace(
    /,\s*-- 0339:[^\n]*\n\s*"redirect_uris"[^\n]*\n/,
    "\n"
  );
  const oauth = BASELINE_OAUTH.split("\n")
    .filter((l) => !l.includes("0339") && !l.includes('"app_grant"'))
    .join("\n");
  return `${USERS}\n${apps}\n${oauth}`;
}

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}
const declared = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t)
    .columns.map((c) => c.name)
    .sort();

describe("migration 0339 — app sign-in", { timeout: 60_000 }, () => {
  it("non-vacuity: the pre-0339 shape lacks both columns", async () => {
    const pg = new PGlite();
    await pg.exec(pre0339());
    expect(await columnsOf(pg, "apps")).not.toContain("redirect_uris");
    expect(await columnsOf(pg, "apps")).toContain("agent_user_id");
    expect(await columnsOf(pg, "oauth_authorization_codes")).not.toContain(
      "app_grant"
    );
    expect(await columnsOf(pg, "oauth_authorization_codes")).toContain(
      "resource"
    );
  });

  it("runs twice, keeps existing rows, and ends with exactly the Drizzle columns", async () => {
    const pg = new PGlite();
    await pg.exec(pre0339());
    await pg.query(
      `INSERT INTO apps (owner_user_id, public_id, name) VALUES ('u-1', 'app_1', 'Studio')`
    );
    await pg.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
       VALUES ('h1', 'dcr_x', 'u-1', 'https://claude.ai/cb', 'c', now() + interval '10 minutes')`
    );
    await pg.exec(M0339);
    await pg.exec(M0339);
    const app = await pg.query<{ redirect_uris: string[] }>(
      `SELECT redirect_uris FROM apps WHERE public_id = 'app_1'`
    );
    expect(app.rows[0]?.redirect_uris).toEqual([]);
    const code = await pg.query<{ app_grant: unknown }>(
      `SELECT app_grant FROM oauth_authorization_codes WHERE code_hash = 'h1'`
    );
    expect(code.rows[0]?.app_grant).toBeNull();
    expect(await columnsOf(pg, "apps")).toEqual(declared(apps));
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
  });

  it("a fresh install (baseline then 0339) ends in the same shape", async () => {
    const pg = new PGlite();
    await pg.exec(`${USERS}\n${BASELINE_APPS}\n${BASELINE_OAUTH}`);
    await pg.exec(M0339);
    expect(await columnsOf(pg, "apps")).toEqual(declared(apps));
    expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
      declared(oauthAuthorizationCodes)
    );
  });

  it("the boot coherence list names both columns, attributed to 0339", () => {
    expect(
      REQUIRED_COLUMNS.filter((r) => r.addedBy === M0339_FILE)
        .map((r) => `${r.table}.${r.column}`)
        .sort()
    ).toEqual(["apps.redirect_uris", "oauth_authorization_codes.app_grant"]);
  });
});
