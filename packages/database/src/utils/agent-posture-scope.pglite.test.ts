/**
 * "Its writes" scope (founder decision 2026-10-08): the ask-first posture
 * applies POD-WIDE or to ONE chosen space — written by THE writer
 * (`applyAgentPosture`, now with `scope`) and decided by THE resolver
 * (`resolveAgentGovernanceDecision`, rung 2.8) on real Postgres. Reachability,
 * not shape: every assertion is a decision the engine returns, plus the read
 * half (`readAgentGovernance().spaces`) the UI renders from.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  applyAgentPosture,
  readAgentGovernance,
  resolveAgentGovernanceDecision,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SALES = "33333333-3333-4333-8333-333333333333";
const OPS = "44444444-4444-4444-8444-444444444444";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb
    );
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      document_id uuid,
      deleted_at timestamptz
    );
    CREATE TYPE governance_principal AS ENUM ('agent','any');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      target_kind governance_target NOT NULL,
      target_pattern text NOT NULL,
      target_profile text,
      verdict governance_verdict NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind text NOT NULL,
      agent_user_id text,
      scope_kind text NOT NULL,
      workspace_id uuid,
      axis text NOT NULL,
      limit_value integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      settings jsonb,
      workspace_type text
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_user_id text,
      is_agent boolean,
      proposal_id uuid,
      timestamp timestamptz NOT NULL DEFAULT now()
    );
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM governance_rules;
    DELETE FROM users;
    DELETE FROM workspaces;
    INSERT INTO workspaces (id, settings, workspace_type) VALUES
      ('${SALES}', '{}'::jsonb, 'team'),
      ('${OPS}', '{}'::jsonb, 'team');
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_metadata)
      VALUES ('${AGENT}', 'agent', '{"agentType":"app","writesRequireProposal":true}'::jsonb);
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'action', '@reversible', 'auto', 'system:reversible-default');
  `);
});

async function decide(workspaceId: string | null, action = "update") {
  const r = await resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId,
    subjectType: "entity",
    action,
    preferAgentMetadataAutoApproveFor: true,
  });
  return r.decision;
}

const space = (workspaceId: string) =>
  ({ kind: "workspace", workspaceId }) as const;

describe("ask-first scope — pod-wide or ONE space", () => {
  it("pod posture: asks first in every space and at pod scope", async () => {
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: { kind: "pod" },
    });
    expect(await decide(null)).toBe("propose");
    expect(await decide(SALES)).toBe("propose");
    expect(await decide(OPS)).toBe("propose");
    const g = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    expect(g.posture).toBe("ask-first");
    expect(g.spaces).toEqual([]);
  });

  it("space posture: asks first in THAT space only; elsewhere the pod default acts", async () => {
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: space(SALES),
    });
    expect(await decide(SALES)).toBe("propose");
    expect(await decide(SALES, "create")).toBe("propose");
    expect(await decide(OPS)).toBe("execute");
    expect(await decide(null)).toBe("execute");
    const g = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    // The pod marker is untouched — a space posture is not a pod fact.
    expect(g.posture).toBeNull();
    expect(g.rules).toEqual([]);
    expect(g.spaces).toEqual([{ workspaceId: SALES, posture: "ask-first" }]);
    expect(g.configured).toBe(true);
  });

  it("a space posture overrides the pod posture in that space only", async () => {
    // Pod: create-with-undo (creates act, edits ask). Sales: ask-first.
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: space(SALES),
    });
    expect(await decide(SALES, "create")).toBe("propose");
    expect(await decide(SALES, "update")).toBe("propose");
    expect(await decide(OPS, "create")).toBe("execute");
    expect(await decide(OPS, "update")).toBe("propose");
    expect(await decide(null, "create")).toBe("execute");
    const g = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    expect(g.posture).toBe("create-with-undo");
    expect(g.spaces).toEqual([{ workspaceId: SALES, posture: "ask-first" }]);
  });

  it("NEVER loosens: a laxer space preset cannot reopen what the pod posture asks for", async () => {
    // Rules only resolve per pattern; create-with-undo writes no `entity.create`
    // row, so the pod ask-first row still answers there. Pinned so nobody reads
    // a space preset as a way to widen an agent.
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
      scope: space(SALES),
    });
    expect(await decide(SALES, "create")).toBe("propose");
    expect(
      (await readAgentGovernance({ db, agentUserId: AGENT }))!.spaces
    ).toEqual([{ workspaceId: SALES, posture: "create-with-undo" }]);
  });

  it("revert: clearing a space posture drops only that space's rows", async () => {
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: space(SALES),
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: space(OPS),
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: null,
      createdBy: HUMAN,
      scope: space(SALES),
    });
    expect(await decide(SALES)).toBe("execute");
    expect(await decide(OPS)).toBe("propose");
    const g = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    expect(g.spaces).toEqual([{ workspaceId: OPS, posture: "ask-first" }]);
  });

  it("a space posture REPLACE never touches a rule a person authored for that space, nor the pod posture", async () => {
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
      VALUES ('agent', '${AGENT}', 'workspace', '${SALES}', 'action', 'relation.update', 'auto', 'user:${HUMAN}');
    `);
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
      scope: space(SALES),
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: null,
      createdBy: HUMAN,
      scope: space(SALES),
    });
    const res = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM governance_rules WHERE revoked_at IS NULL AND created_by = 'user:${HUMAN}'`
    );
    expect(res.rows[0]!.n).toBe(1);
    // Pod posture intact: Sales falls back to it, so edits still ask there.
    expect(await decide(SALES)).toBe("propose");
    expect(
      (await readAgentGovernance({ db, agentUserId: AGENT }))!.posture
    ).toBe("ask-first");
  });
});
