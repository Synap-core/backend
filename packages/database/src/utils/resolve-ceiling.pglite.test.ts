/**
 * THE ceiling resolver (the caps fold, W1c / 0330), on real Postgres (PGlite):
 *   - migration 0330 runs inside ONE transaction, twice;
 *   - no row ⇒ CEILING_DEFAULTS[axis], source "default";
 *   - most specific row wins: subject (+8) > principal > scope, newest on a tie;
 *   - a row naming ANOTHER subject never applies;
 *   - a tighten-only axis never resolves above its default;
 *   - the two older readers (daily writes, pending proposals) answer through it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { CEILING_DEFAULTS } from "@synap/governance-policy";
import {
  resolveCeiling,
  resolveDailyWriteCeiling,
  resolvePendingProposalCap,
} from "./resolve-agent-governance-decision.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0330 = readFileSync(
  resolve(HERE, "../../migrations/0330_governance_ceiling_axes_fold.sql"),
  "utf8"
);

const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const AUTOMATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AUTOMATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id text PRIMARY KEY, agent_type text);
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_ceiling_axis AS ENUM ('daily_write_count','pending_proposal_cap');
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      axis governance_ceiling_axis NOT NULL,
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      limit_value integer NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
  `);
  // As the migrator runs it: one transaction — and a second time, idempotent.
  for (let i = 0; i < 2; i++) {
    await pg.exec(`BEGIN; ${M0330} COMMIT;`);
  }
  await pg.query(`INSERT INTO users (id, agent_type) VALUES ($1, 'claude-code'), ($2, 'codex')`, [AGENT, OTHER_AGENT]);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.query(`DELETE FROM governance_ceilings`);
});

async function row(p: {
  axis: string;
  limit: number;
  agent?: string;
  workspace?: string;
  subject?: string;
  at?: string;
}) {
  await pg.query(
    `INSERT INTO governance_ceilings (axis, principal_kind, agent_user_id, scope_kind, workspace_id, subject_type, subject_id, limit_value, created_by, created_at)
     VALUES ($1::governance_ceiling_axis, $2, $3, $4, $5, $6, $7, $8, 'test', $9)`,
    [
      p.axis,
      p.agent ? "agent" : "any",
      p.agent ?? null,
      p.workspace ? "workspace" : "pod",
      p.workspace ?? null,
      p.subject ? "automation" : null,
      p.subject ?? null,
      p.limit,
      p.at ?? new Date().toISOString(),
    ]
  );
}

const subject = { type: "automation", id: AUTOMATION };

describe("resolveCeiling", () => {
  it("migration 0330 added the four axes and the subject columns", async () => {
    const axes = await pg.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::governance_ceiling_axis))::text AS v`
    );
    expect(axes.rows.map((r) => r.v).sort()).toEqual(
      Object.keys(CEILING_DEFAULTS).sort()
    );
  });

  it("no row ⇒ the default, said as such", async () => {
    for (const axis of Object.keys(CEILING_DEFAULTS) as Array<
      keyof typeof CEILING_DEFAULTS
    >) {
      expect(await resolveCeiling({ db, axis })).toEqual({
        value: CEILING_DEFAULTS[axis],
        source: "default",
        ceilingId: null,
      });
    }
  });

  it("a subject row outranks an agent + workspace row", async () => {
    await row({ axis: "automation_ai_dispatch_daily", limit: 7, agent: AGENT, workspace: WS });
    await row({ axis: "automation_ai_dispatch_daily", limit: 3, subject: AUTOMATION });
    const r = await resolveCeiling({
      db,
      axis: "automation_ai_dispatch_daily",
      agentUserId: AGENT,
      workspaceId: WS,
      subject,
    });
    expect(r).toMatchObject({ value: 3, source: "row" });
  });

  it("a row for another subject never applies", async () => {
    await row({ axis: "automation_ai_dispatch_per_run", limit: 2, subject: OTHER_AUTOMATION });
    expect(
      await resolveCeiling({ db, axis: "automation_ai_dispatch_per_run", subject })
    ).toMatchObject({ value: CEILING_DEFAULTS.automation_ai_dispatch_per_run, source: "default" });
  });

  it("principal and scope rank as the rule resolver ranks them; newest breaks a tie", async () => {
    await row({ axis: "daily_write_count", limit: 100 });
    await row({ axis: "daily_write_count", limit: 80, agent: AGENT });
    await row({ axis: "daily_write_count", limit: 60, agent: AGENT, workspace: WS, at: "2026-01-01T00:00:00Z" });
    await row({ axis: "daily_write_count", limit: 40, agent: AGENT, workspace: WS, at: "2026-06-01T00:00:00Z" });
    expect(await resolveDailyWriteCeiling({ db, agentUserId: AGENT })).toBe(80);
    expect(await resolveDailyWriteCeiling({ db, agentUserId: AGENT, workspaceId: WS })).toBe(40);
    expect(await resolveDailyWriteCeiling({ db, agentUserId: OTHER_AGENT })).toBe(100);
  });

  it("a tighten-only axis never resolves above its default", async () => {
    await row({ axis: "worker_irreversible_sends_daily", limit: 500, subject: AUTOMATION });
    expect(
      await resolveCeiling({ db, axis: "worker_irreversible_sends_daily", subject })
    ).toMatchObject({ value: CEILING_DEFAULTS.worker_irreversible_sends_daily, source: "row" });
    await pg.query(`DELETE FROM governance_ceilings`);
    await row({ axis: "worker_irreversible_sends_daily", limit: 5, subject: AUTOMATION });
    expect(
      (await resolveCeiling({ db, axis: "worker_irreversible_sends_daily", subject })).value
    ).toBe(5);
  });

  it("the pending-proposal reader still answers null when no row decided", async () => {
    expect(await resolvePendingProposalCap({ db, agentUserId: AGENT })).toBeNull();
    await row({ axis: "pending_proposal_cap", limit: 4, agent: AGENT });
    expect(await resolvePendingProposalCap({ db, agentUserId: AGENT })).toBe(4);
  });
});
