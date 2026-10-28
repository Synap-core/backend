/**
 * REAL-POSTGRES (PGlite) test for migration 0363 — `key_requests` and
 * `grant_roles.uses`:
 *  - idempotent (applied twice) on a pre-0363 schema;
 *  - the status CHECK refuses a status outside the lifecycle;
 *  - one row per request code (unique hash);
 *  - the Drizzle schema declares every column, the fresh-DB baseline carries
 *    the same DDL, and the boot coherence list names it, attributed to 0363.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { keyRequests } from "./schema/key-requests.js";
import { grantRoles } from "./schema/grant-roles.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const FILE = "0363_key_requests_and_role_uses.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE grant_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL);
    INSERT INTO users (id) VALUES ('computer'), ('person');
    INSERT INTO grant_roles (user_id) VALUES ('person');
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const sqlState = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
};

const insert = (hash: string, status = "pending") =>
  pg.query(
    `INSERT INTO key_requests (request_code_hash, status, requester_user_id, person_user_id, template_id, requested_name, expires_at)
     VALUES ($1, $2, 'computer', 'person', 'dev-loop-poster', 'poster', now() + interval '15 minutes')`,
    [hash, status]
  );

describe("0363 key_requests + grant_roles.uses", () => {
  it("a pending request lands; the lifecycle CHECK refuses anything else", async () => {
    expect(await sqlState(insert("h1"))).toBeNull();
    // 23514 = check_violation.
    expect(await sqlState(insert("h2", "minted"))).toBe("23514");
  });

  it("one row per request code (23505 on a second)", async () => {
    expect(await sqlState(insert("h1"))).toBe("23505");
  });

  it("existing roles keep NULL uses (they set no door)", async () => {
    const r = await pg.query<{ uses: string[] | null }>(
      `SELECT uses FROM grant_roles`
    );
    expect(r.rows).toEqual([{ uses: null }]);
  });

  it("the drizzle schema declares exactly the migration's columns", async () => {
    const live = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'key_requests'`
    );
    expect(live.rows.map((r) => r.column_name).sort()).toEqual(
      getTableConfig(keyRequests)
        .columns.map((c) => c.name)
        .sort()
    );
    expect(getTableConfig(grantRoles).columns.map((c) => c.name)).toContain(
      "uses"
    );
  });

  it("the fresh-DB baseline carries the same DDL", () => {
    const block = (sql: string) =>
      /CREATE TABLE IF NOT EXISTS "key_requests" \(([\s\S]*?)\n\);/.exec(
        sql
      )?.[1];
    expect(block(BASELINE)).toBeTruthy();
    expect(block(BASELINE)).toBe(block(MIGRATION));
    expect(BASELINE).toContain(
      `ALTER TABLE "grant_roles" ADD COLUMN IF NOT EXISTS "uses" text[];`
    );
  });

  it("the boot coherence check names both, attributed to 0363", () => {
    const mine = REQUIRED_COLUMNS.filter((c) => c.addedBy === FILE);
    expect(mine.map((c) => `${c.table}.${c.column}`).sort()).toEqual([
      "grant_roles.uses",
      "key_requests.approved_draft",
      "key_requests.request_code_hash",
    ]);
  });
});
