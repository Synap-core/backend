/**
 * REAL-POSTGRES (PGlite) test for migration 0263 — `profiles.origin`,
 * `lifecycle`, `owner_kind`/`owner_id`:
 *  - the migration adds exactly the columns the Drizzle schema declares,
 *    idempotently, with the CHECKs refusing an unknown vocabulary;
 *  - the BACKFILL classifies honestly, by ROW IDENTITY only: system → core; an
 *    agent receipt or approved pending proposal whose target_id is the row →
 *    agent; a human receipt, a template workspace row, a rejected proposal, an
 *    executor-approved kind with a fresh id and a LATER human row reusing an
 *    agent proposal's slug → unknown (never guessed from slug + order, R5);
 *  - the boot coherence check reports a pod that skipped 0263;
 *  - the fresh-DB baseline declares the same columns.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const h = vi.hoisted(() => ({ pg: null as null | PGlite }));

vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      ""
    );
    return (await h.pg!.query(text, values)).rows;
  };
  return { ...actual, sql };
});

import { checkSchemaCoherence } from "./schema-coherence.js";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);
const MIGRATION = readFileSync(
  resolve(MIGRATIONS, "0263_profiles_origin_lifecycle.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(MIGRATIONS, "0000_baseline_schema.sql"),
  "utf8"
);

const WS = "11111111-1111-4111-8111-111111111111";
const ID = {
  system: "a0000000-0000-4000-8000-000000000001",
  agentReceipt: "a0000000-0000-4000-8000-000000000002",
  agentPending: "a0000000-0000-4000-8000-000000000003",
  humanReceipt: "a0000000-0000-4000-8000-000000000004",
  template: "a0000000-0000-4000-8000-000000000005",
  beforeProposal: "a0000000-0000-4000-8000-000000000006",
  // R5 discriminating rows: an executor-approved agent kind (fresh id, no link
  // to the row) and a LATER human row reusing a slug an agent proposal named.
  executorMinted: "a0000000-0000-4000-8000-000000000007",
  laterHuman: "a0000000-0000-4000-8000-000000000008",
  rejectedAgent: "a0000000-0000-4000-8000-000000000009",
};

const NEW_COLUMNS = ["origin", "lifecycle", "owner_kind", "owner_id"];

beforeAll(async () => {
  h.pg = new PGlite();
  await h.pg.exec(`
    CREATE TABLE profiles (
      id uuid PRIMARY KEY, slug text NOT NULL, scope text NOT NULL,
      workspace_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE proposals (
      id uuid PRIMARY KEY, workspace_id text, target_type text NOT NULL,
      target_id text NOT NULL, proposal_type text NOT NULL, data jsonb NOT NULL,
      status text NOT NULL, agent_user_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO profiles (id, slug, scope, workspace_id, created_at) VALUES
      ('${ID.system}',         'person',          'system',    NULL,   '2026-08-01'),
      ('${ID.agentReceipt}',   'dogfood-probe-c', 'workspace', '${WS}', '2026-08-16'),
      ('${ID.agentPending}',   'podcast',         'workspace', '${WS}', '2026-09-02'),
      ('${ID.humanReceipt}',   'invoice',         'workspace', '${WS}', '2026-08-20'),
      ('${ID.template}',       'campaign',        'workspace', '${WS}', '2026-07-01'),
      ('${ID.beforeProposal}', 'workout',         'workspace', '${WS}', '2026-06-01'),
      ('${ID.executorMinted}', 'recipe',          'workspace', '${WS}', '2026-08-11'),
      ('${ID.laterHuman}',     'podcast-episode', 'workspace', '${WS}', '2026-09-10'),
      ('${ID.rejectedAgent}',  'rejected-kind',   'workspace', '${WS}', '2026-08-12');
    INSERT INTO proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_at) VALUES
      -- auto-approve receipt, agent-attributed, target_id = the row id
      ('b0000000-0000-4000-8000-000000000001', '${WS}', 'profile', '${ID.agentReceipt}', 'profile.create',
        '{"slug":"dogfood-probe-c"}', 'auto_approved', 'agent-1', '2026-08-16'),
      -- approved PENDING proposal the async materializer applied: it creates
      -- with the pre-minted target_id, so the row id IS the target_id
      ('b0000000-0000-4000-8000-000000000002', '${WS}', 'profile', '${ID.agentPending}', 'create',
        '{"data":{"slug":"podcast"}}', 'approved', 'agent-1', '2026-09-01'),
      -- approved PENDING proposal the sync executor applied: fresh row id, so
      -- nothing links it to the row (same slug + ws, filed before the row)
      ('b0000000-0000-4000-8000-000000000005', '${WS}', 'profile', 'c0000000-0000-4000-8000-000000000007', 'create',
        '{"data":{"slug":"recipe"}}', 'approved', 'agent-1', '2026-08-10'),
      -- an approved agent proposal for 'podcast-episode' whose kind was later
      -- retired; a HUMAN re-created the slug afterwards (a different row)
      ('b0000000-0000-4000-8000-000000000006', '${WS}', 'profile', 'c0000000-0000-4000-8000-000000000006', 'create',
        '{"data":{"slug":"podcast-episode"}}', 'approved', 'agent-1', '2026-09-05'),
      -- a REJECTED agent proposal naming the row id: it authorized nothing
      ('b0000000-0000-4000-8000-000000000007', '${WS}', 'profile', '${ID.rejectedAgent}', 'profile.create',
        '{"slug":"rejected-kind"}', 'rejected', 'agent-1', '2026-08-12'),
      -- human receipt: no agent attribution
      ('b0000000-0000-4000-8000-000000000003', '${WS}', 'profile', '${ID.humanReceipt}', 'profile.create',
        '{"slug":"invoice"}', 'auto_approved', NULL, '2026-08-20'),
      -- an agent proposal for 'workout' filed AFTER the row already existed
      ('b0000000-0000-4000-8000-000000000004', '${WS}', 'profile', 'c0000000-0000-4000-8000-000000000008', 'create',
        '{"data":{"slug":"workout"}}', 'approved', 'agent-1', '2026-09-03');
  `);
}, 120_000);

afterAll(async () => {
  await h.pg?.close();
});

const originOf = async (id: string) =>
  (
    await h.pg!.query<{ origin: string; owner_kind: string | null }>(
      `SELECT origin, owner_kind FROM profiles WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("profiles origin/lifecycle — migration 0263", () => {
  it("a pod that skipped 0263 is reported by the coherence check", async () => {
    const { missing } = await checkSchemaCoherence();
    const reported = missing
      .filter((m) => m.table === "profiles")
      .map((m) => m.column);
    for (const c of NEW_COLUMNS) expect(reported).toContain(c);
  });

  it("0263 applies, re-runs cleanly, and the report clears", async () => {
    await h.pg!.exec(MIGRATION);
    await h.pg!.exec(MIGRATION);
    const { missing } = await checkSchemaCoherence();
    expect(
      missing.filter(
        (m) => m.table === "profiles" && NEW_COLUMNS.includes(m.column)
      )
    ).toEqual([]);
  });

  it("backfill: system → core", async () => {
    expect((await originOf(ID.system)).origin).toBe("core");
  });

  it("backfill: agent receipt (id join) → agent, owned by the proposal", async () => {
    expect(await originOf(ID.agentReceipt)).toEqual({
      origin: "agent",
      owner_kind: "proposal",
    });
  });

  it("backfill: approved agent pending proposal whose target_id is the row (async materializer) → agent", async () => {
    expect((await originOf(ID.agentPending)).origin).toBe("agent");
  });

  it("R5: a LATER human row reusing a slug an approved agent proposal named stays non-agent", async () => {
    // Discriminating row: a slug + workspace + order join claims it; row
    // identity does not.
    expect((await originOf(ID.laterHuman)).origin).toBe("unknown");
  });

  it("R5: an executor-approved agent kind (fresh id, no row link) is not guessed", async () => {
    expect((await originOf(ID.executorMinted)).origin).toBe("unknown");
  });

  it("a REJECTED agent proposal naming the row id authorized nothing → unknown", async () => {
    expect((await originOf(ID.rejectedAgent)).origin).toBe("unknown");
  });

  it("backfill never guesses: human receipt, template-workspace row, row older than its proposal → unknown", async () => {
    expect((await originOf(ID.humanReceipt)).origin).toBe("unknown");
    expect((await originOf(ID.template)).origin).toBe("unknown");
    expect((await originOf(ID.beforeProposal)).origin).toBe("unknown");
  });

  it("every row defaults to lifecycle active", async () => {
    const { rows } = await h.pg!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM profiles WHERE lifecycle <> 'active'`
    );
    expect(rows[0].n).toBe(0);
  });

  it("CHECKs refuse an unknown origin, lifecycle, or a half owner", async () => {
    await expect(
      h.pg!.exec(
        `UPDATE profiles SET origin = 'guess' WHERE id = '${ID.system}'`
      )
    ).rejects.toThrow();
    await expect(
      h.pg!.exec(
        `UPDATE profiles SET lifecycle = 'retired' WHERE id = '${ID.system}'`
      )
    ).rejects.toThrow();
    await expect(
      h.pg!.exec(
        `UPDATE profiles SET owner_kind = 'package' WHERE id = '${ID.system}'`
      )
    ).rejects.toThrow();
  });

  it("the baseline declares the four columns on profiles", () => {
    const table = BASELINE.slice(
      BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "profiles"'),
      BASELINE.indexOf(
        "CREATE TABLE IF NOT EXISTS",
        BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "profiles"') + 10
      )
    );
    for (const c of NEW_COLUMNS) {
      expect(table).toMatch(new RegExp(`"${c}"\\s+text`));
    }
  });
});
