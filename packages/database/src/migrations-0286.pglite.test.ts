/**
 * REAL-POSTGRES (PGlite) test for migration 0286 — undouble the
 * `<t>.<t>.<verb>` action patterns the lane scanner minted before edec5fa4.
 *
 * Pinned: a lone dead rule is rewritten in place (id kept); a dead rule whose
 * corrected twin exists is DELETED (no duplicate, and a revoked twin is not
 * revived); two dead rows collapsing to one corrected rule leave ONE (the
 * active one); a legit pattern and a non-action rule are untouched; a pending
 * widen-lane proposal is repaired, a decided one is not; a second run changes
 * nothing.
 *
 * `governance_rules` / `proposals` here are the minimal slices 0286 reads and
 * writes, not the full tables (enums as text).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(
    HERE,
    "../migrations/0286_governance_rules_undouble_action_prefix.sql"
  ),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE governance_rules (
      id text PRIMARY KEY,
      principal_kind text NOT NULL,
      agent_user_id text,
      scope_kind text NOT NULL,
      workspace_id uuid,
      target_kind text NOT NULL,
      target_pattern text NOT NULL,
      target_profile text,
      verdict text NOT NULL,
      created_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE proposals (
      id text PRIMARY KEY,
      proposal_type text NOT NULL,
      status text NOT NULL,
      data jsonb
    );
    INSERT INTO governance_rules VALUES
      -- lone dead rule → rewritten in place
      ('lone',       'agent', 'a1', 'pod', NULL, 'action', 'entity.entity.create', NULL, 'auto', '2026-09-01', NULL),
      -- dead rule + ACTIVE corrected twin → dead one deleted
      ('dup-dead',   'agent', 'a2', 'pod', NULL, 'action', 'document.document.update', NULL, 'auto', '2026-09-01', NULL),
      ('dup-live',   'agent', 'a2', 'pod', NULL, 'action', 'document.update', NULL, 'auto', '2026-09-02', NULL),
      -- dead ACTIVE rule + REVOKED corrected twin → dead one deleted (revoke respected)
      ('rev-dead',   'agent', 'a3', 'pod', NULL, 'action', 'entity.entity.update', NULL, 'auto', '2026-09-01', NULL),
      ('rev-twin',   'agent', 'a3', 'pod', NULL, 'action', 'entity.update', NULL, 'auto', '2026-09-02', '2026-09-03'),
      -- two dead rows, same corrected rule, no twin → keep the ACTIVE one
      ('pair-old',   'agent', 'a4', 'pod', NULL, 'action', 'link.link.create', NULL, 'auto', '2026-08-01', '2026-08-02'),
      ('pair-new',   'agent', 'a4', 'pod', NULL, 'action', 'link.link.create', NULL, 'auto', '2026-09-01', NULL),
      -- same doubled pattern, DIFFERENT agent → its own rule, rewritten
      ('other-agent','agent', 'a5', 'pod', NULL, 'action', 'document.document.update', NULL, 'auto', '2026-09-01', NULL),
      -- untouched: a legit action pattern, a lookalike, a non-action rule
      ('legit',      'agent', 'a1', 'pod', NULL, 'action', 'entity.update', NULL, 'auto', '2026-09-01', NULL),
      ('lookalike',  'agent', 'a1', 'pod', NULL, 'action', 'entity.entity_type.create', NULL, 'auto', '2026-09-01', NULL),
      ('capability', 'agent', 'a1', 'pod', NULL, 'capability', 'gmail.gmail.send', NULL, 'auto', '2026-09-01', NULL);
    INSERT INTO proposals VALUES
      ('p-pending',  'governance.widen_lane', 'pending',  '{"targetKind":"action","targetPattern":"entity.entity.create","agentUserId":"a1"}'),
      ('p-approved', 'governance.widen_lane', 'approved', '{"targetKind":"action","targetPattern":"entity.entity.create","agentUserId":"a1"}'),
      ('p-other',    'entity.create',          'pending',  '{"targetKind":"action","targetPattern":"entity.entity.create"}');
  `);
});

afterAll(async () => {
  await pg.close();
});

const rules = async () =>
  Object.fromEntries(
    (
      await pg.query<{ id: string; target_pattern: string }>(
        "SELECT id, target_pattern FROM governance_rules ORDER BY id"
      )
    ).rows.map((r) => [r.id, r.target_pattern])
  );
const proposalPatterns = async () =>
  Object.fromEntries(
    (
      await pg.query<{ id: string; p: string }>(
        "SELECT id, data->>'targetPattern' AS p FROM proposals ORDER BY id"
      )
    ).rows.map((r) => [r.id, r.p])
  );

describe("0286 undouble governance action patterns", () => {
  it("rewrites, dedups, respects revokes, and is idempotent", async () => {
    await pg.exec(MIGRATION);
    const first = await rules();
    expect(first).toEqual({
      lone: "entity.create",
      "dup-live": "document.update",
      "rev-twin": "entity.update",
      "pair-new": "link.create",
      "other-agent": "document.update",
      legit: "entity.update",
      lookalike: "entity.entity_type.create",
      capability: "gmail.gmail.send",
    });
    expect(await proposalPatterns()).toEqual({
      "p-pending": "entity.create",
      "p-approved": "entity.entity.create",
      "p-other": "entity.entity.create",
    });

    await pg.exec(MIGRATION);
    expect(await rules()).toEqual(first);
  });
});
