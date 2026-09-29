/**
 * Migration 0287 → `withAgentOrigin` (the `agentUsers.list` projection): an IS
 * persona the pod runs, whose agent-user predates 0225 (`created_via` NULL),
 * must read `direction: 'house'` once the backfill has run — identified by its
 * `agents` catalog link (`owner_type = 'synap'`), never by name.
 *
 * Driven from the REAL migration file on PGlite through the REAL projection;
 * nothing hand-built between the SQL and the direction. `users` / `agents` are
 * the minimal slices 0287 reads and writes.
 *
 * Negative controls in the same table: a NULL agent with NO catalog link, one
 * linked only as a person's local adjunct (`owner_type = 'user'`), and a
 * `cli`-stamped agent that an IS catalog row also points at — all stay
 * `external`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { withAgentOrigin } from "./agent-users.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(
    HERE,
    "../../../database/migrations/0287_backfill_is_persona_created_via.sql"
  ),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      is_personal_agent boolean DEFAULT false,
      created_via text
    );
    CREATE TABLE agents (
      id text PRIMARY KEY,
      owner_type text NOT NULL DEFAULT 'system',
      user_id text
    );
    INSERT INTO users (id, user_type, created_via) VALUES
      ('persona',  'agent', NULL),
      ('orphan',   'agent', NULL),
      ('adjunct',  'agent', NULL),
      ('cli',      'agent', 'cli'),
      ('human',    'human', NULL);
    INSERT INTO agents (id, owner_type, user_id) VALUES
      ('cat-persona', 'synap', 'persona'),
      ('cat-adjunct', 'user',  'adjunct'),
      ('cat-cli',     'synap', 'cli'),
      ('cat-human',   'synap', 'human');
  `);
});

afterAll(async () => {
  await pg.close();
});

const directions = async () => {
  const rows = (
    await pg.query<{
      id: string;
      created_via: string | null;
      is_personal_agent: boolean | null;
    }>("SELECT id, created_via, is_personal_agent FROM users ORDER BY id")
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      [
        r.created_via,
        withAgentOrigin({
          createdVia: r.created_via,
          isPersonalAgent: r.is_personal_agent,
          activeKeys: 0,
          pendingKeys: 0,
          revokedKeys: 0,
        }).direction,
      ],
    ])
  );
};

describe("0287 backfills IS persona origin", () => {
  it("before: the NULL persona reads external (the safe default)", async () => {
    expect((await directions()).persona).toEqual([null, "external"]);
  });

  it("after: only the catalog-linked persona becomes house; re-run is a no-op", async () => {
    await pg.exec(MIGRATION);
    const first = await directions();
    expect(first).toEqual({
      persona: ["intelligence-service", "house"],
      orphan: [null, "external"],
      adjunct: [null, "external"],
      cli: ["cli", "external"],
      human: [null, "external"],
    });
    await pg.exec(MIGRATION);
    expect(await directions()).toEqual(first);
  });
});
