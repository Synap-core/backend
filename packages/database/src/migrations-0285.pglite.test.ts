/**
 * REAL-POSTGRES (PGlite) test for migration 0285 — backfill `created_via` on
 * the pod's own agents (capture, form, twin) that pre-date 0225.
 *
 * Pinned: exactly those NULL rows become 'system'; a person's agent with NULL
 * stays NULL (never claimed as built-in); a value a writer stamped is never
 * overwritten; humans are untouched; a second run changes nothing.
 *
 * `users` here is the minimal slice 0285 reads/writes, not the full table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0285_backfill_agent_created_via.sql"),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_type text,
      is_personal_agent boolean NOT NULL DEFAULT false,
      created_via text
    );
    INSERT INTO users (id, user_type, agent_type, is_personal_agent, created_via) VALUES
      ('capture', 'agent', 'capture', false, NULL),
      ('form',    'agent', 'form:9c19', false, NULL),
      ('twin',    'agent', 'personal', true, NULL),
      ('mine',    'agent', 'claude-code', false, NULL),
      ('stamped', 'agent', 'capture', false, 'cli'),
      ('human',   'human', NULL, false, NULL);
  `);
});

afterAll(async () => {
  await pg.close();
});

const snapshot = async () =>
  (
    await pg.query<{ id: string; created_via: string | null }>(
      "SELECT id, created_via FROM users ORDER BY id"
    )
  ).rows;

describe("0285 backfill agent created_via", () => {
  it("stamps only the pod's own NULL agents, and is idempotent", async () => {
    await pg.exec(MIGRATION);
    const first = await snapshot();
    expect(Object.fromEntries(first.map((r) => [r.id, r.created_via]))).toEqual({
      capture: "system",
      form: "system",
      twin: "system",
      mine: null,
      stamped: "cli",
      human: null,
    });
    await pg.exec(MIGRATION);
    expect(await snapshot()).toEqual(first);
  });
});
