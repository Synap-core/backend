/**
 * REAL-POSTGRES (PGlite) test for migration 0448 — the CONTRACT step of 0435
 * (decisions D2 and D3, document b387ca45): `vault_grants.exec_mode` and the
 * `grant_exec_mode` type are dropped once no code that may run again reads
 * them.
 *   - on a pod updating across both, 0435 runs first and moves an auto
 *     grant's verdict into an approval row; 0448 then drops the column and
 *     the type, keeping every grant and the row;
 *   - the file runs twice;
 *   - it carries the forward-only marker naming 0435
 *     (`check-migrations-forward-only.mjs`), and that file exists;
 *   - the baseline (a fresh pod) carries neither the column nor the type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../migrations");
const read = (f: string) => readFileSync(resolve(MIGRATIONS, f), "utf8");
const EXPAND = "0435_grant_exec_mode_to_approval_rows.sql";
const M0448 = read("0448_drop_grant_exec_mode.sql");
const BASELINE = read("0000_baseline_schema.sql");

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS = "11111111-1111-4111-8111-111111111111";
const TOOL = "30000000-0000-4000-8000-000000000001";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The tables 0435 reads, as they stood before it.
  await pg.exec(`
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose','deny');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      target_kind governance_target NOT NULL,
      target_pattern text NOT NULL,
      verdict governance_verdict NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE tools (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE skills (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TYPE grantable_type AS ENUM ('secret','tool','skill','command');
    CREATE TYPE grant_exec_mode AS ENUM ('auto','propose','dry-run');
    CREATE TABLE vault_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grantable_type grantable_type NOT NULL,
      grantable_id text NOT NULL,
      exec_mode grant_exec_mode NOT NULL DEFAULT 'auto',
      granted_to text,
      workspace_id uuid,
      expires_at timestamptz,
      max_uses integer,
      use_count integer NOT NULL DEFAULT 0,
      revoked_at timestamptz,
      created_by text NOT NULL
    );
    INSERT INTO tools (id, name) VALUES ('${TOOL}', 'mail_send');
    INSERT INTO vault_grants (grantable_type, grantable_id, exec_mode, granted_to, workspace_id, created_by)
    VALUES ('tool', '${TOOL}', 'auto', '${AGENT}', '${WS}', 'person');
  `);
  await pg.exec(read(EXPAND));
  await pg.exec(M0448);
  await pg.exec(M0448);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe("migration 0448 — the contract step of 0435", () => {
  it("drops the column and the type, keeping the grant and its approval row", async () => {
    const col = await pg.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vault_grants' AND column_name = 'exec_mode'`
    );
    expect(col.rows).toHaveLength(0);
    const type = await pg.query(
      `SELECT 1 FROM pg_type WHERE typname = 'grant_exec_mode'`
    );
    expect(type.rows).toHaveLength(0);
    const grants = await pg.query(`SELECT grantable_id FROM vault_grants`);
    expect(grants.rows).toEqual([{ grantable_id: TOOL }]);
    const rules = await pg.query<{ verdict: string; agent_user_id: string }>(
      `SELECT verdict, agent_user_id FROM governance_rules`
    );
    expect(rules.rows).toEqual([{ verdict: "auto", agent_user_id: AGENT }]);
  });

  it("carries the forward-only marker naming the expand step, which exists", () => {
    const marker = M0448.match(
      /^[ \t]*--[ \t]*synap:contract-of[ \t]+(\S+)[ \t]*$/m
    );
    expect(marker?.[1]).toBe(EXPAND);
    expect(existsSync(resolve(MIGRATIONS, EXPAND))).toBe(true);
  });

  it("a fresh pod's baseline carries neither the column nor the type", () => {
    expect(BASELINE).not.toContain("exec_mode");
    expect(BASELINE).not.toContain("grant_exec_mode");
  });
});
