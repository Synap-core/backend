/**
 * The READ SNAPSHOT (`read-snapshot.ts`) keeps ONE governance ladder for the
 * agent × work matrix: every dry run through the snapshot must answer exactly
 * what the same dry run answers on the real handle — while identical reads
 * hit the database once. And it can never write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  createReadSnapshot,
  dryRunAgentGovernanceDecision,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";
const COMPUTER = "44444444-4444-4444-8444-444444444444";
const WS_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY, user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb, agent_type text, host_user_id text
    );
    CREATE TABLE workspaces (id uuid PRIMARY KEY, settings jsonb, workspace_type text);
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL,
      document_id uuid, deleted_at timestamptz
    );
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL, agent_user_id text, principal_class text,
      scope_kind governance_scope NOT NULL, workspace_id uuid,
      target_kind governance_target NOT NULL, target_pattern text NOT NULL, target_profile text,
      verdict governance_verdict NOT NULL, source_proposal_id uuid, created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, expires_at timestamptz
    );
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind text NOT NULL, agent_user_id text, principal_class text,
      scope_kind text NOT NULL, workspace_id uuid, axis text NOT NULL,
      limit_value integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz, expires_at timestamptz, subject_type text, subject_id text
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_user_id text,
      is_agent boolean, proposal_id uuid, timestamp timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_type) VALUES ('${COMPUTER}', 'agent', 'machine');
    INSERT INTO users (id, user_type, agent_type) VALUES ('${AGENT_A}', 'agent', 'claude-code');
    INSERT INTO users (id, user_type, agent_type, host_user_id, agent_metadata)
      VALUES ('${AGENT_B}', 'agent', 'codex', '${COMPUTER}', '{"writesRequireProposal": true}');
    INSERT INTO workspaces (id, settings, workspace_type) VALUES ('${WS_1}', '{}', 'standard'), ('${WS_2}', '{}', 'standard');
    -- A mix the ladder must rank: an agent rule, a workspace rule, a class row, the pod default.
    INSERT INTO governance_rules (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('agent', '${AGENT_A}', 'pod', 'action', 'entity.update', 'auto', 'x');
    INSERT INTO governance_rules (principal_kind, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
      VALUES ('any', 'workspace', '${WS_2}', 'action', 'entity.create', 'propose', 'x');
    INSERT INTO governance_rules (principal_kind, principal_class, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('class', 'machine', 'pod', 'action', 'entity.*', 'propose', 'x');
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'action', '@reversible', 'auto', 'x');
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

const CASES = (() => {
  const out: Array<{ agentUserId: string; workspaceId: string | null; action: string }> = [];
  for (const agentUserId of [AGENT_A, AGENT_B])
    for (const workspaceId of [null, WS_1, WS_2])
      for (const action of ["entity.create", "entity.update", "entity.delete", "entity.transition", "document.update"])
        out.push({ agentUserId, workspaceId, action });
  return out;
})();

const ask = (handle: unknown, c: (typeof CASES)[number]) =>
  dryRunAgentGovernanceDecision({
    db: handle as never,
    userId: HUMAN,
    agentUserId: c.agentUserId,
    workspaceId: c.workspaceId,
    action: c.action,
    door: "chat",
  });

describe("createReadSnapshot", () => {
  it("answers every dry run exactly as the real handle does", async () => {
    expect(CASES.length).toBe(30); // non-vacuity
    const direct = [];
    for (const c of CASES) direct.push(await ask(db, c));
    const snap = createReadSnapshot(db);
    const through = await Promise.all(CASES.map((c) => ask(snap.db, c)));
    expect(through).toEqual(direct);
    // The mix is real: the cases do not all agree.
    expect(new Set(direct.map((d) => d.outcome)).size).toBeGreaterThan(1);
  });

  it("identical reads hit the database once", async () => {
    const snap = createReadSnapshot(db);
    await Promise.all(CASES.map((c) => ask(snap.db, c)));
    const first = snap.stats();
    expect(first.hits).toBeGreaterThan(first.queries);
    // Asking everything again costs nothing.
    await Promise.all(CASES.map((c) => ask(snap.db, c)));
    expect(snap.stats().queries).toBe(first.queries);
  });

  it("can never write", () => {
    const snap = createReadSnapshot(db);
    expect(() => snap.db.insert).toThrow(/only reads/);
    expect(() => snap.db.transaction).toThrow(/only reads/);
  });
});
