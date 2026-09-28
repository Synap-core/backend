/**
 * D2 — the `create-with-undo` posture, applied through THE writer
 * (`applyAgentPosture`) and decided through THE resolver
 * (`resolveAgentGovernanceDecision`), on real Postgres. Reachability, not
 * shape: every assertion is a decision the engine actually returns for the
 * agent after the posture is applied — never a check that rows exist.
 *
 * The baseline is a STRICT new agent (`writesRequireProposal: true`, how
 * `findOrCreateServiceAgentUser` inserts one). The POD DEFAULT (`@reversible`
 * row, migration 0282) is what lets it act on reversible writes; the posture
 * is an optional stricter preset on top — it takes edits back, never loosens.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  applyAgentPosture,
  readAgentGovernance,
  resolveAgentGovernanceDecision,
  syncAutoApproveRules,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

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
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_metadata)
      VALUES ('${AGENT}', 'agent', '{"agentType":"cli-agent","writesRequireProposal":true}'::jsonb);
  `);
});

async function decide(subjectType: string, action: string): Promise<string> {
  const resolved = await resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType,
    action,
    preferAgentMetadataAutoApproveFor: true,
  });
  return resolved.decision;
}

const CREATES: Array<[string, string]> = [
  ["entity", "create"],
  ["document", "create"],
  ["relation", "create"],
  ["link", "create"],
  ["view", "create"],
  ["facet", "attach"],
];
const PROPOSES: Array<[string, string]> = [
  ["entity", "update"],
  ["facet", "update"],
  ["facet", "detach"],
  ["document", "update"],
  ["property_def", "create"],
  ["property_def", "update"],
  ["automation", "create"],
  ["entity", "delete"],
  ["document", "delete"],
];

/** The pod default row (migration 0282): `@reversible`, any/pod, auto. */
async function podDefaultOn() {
  await pg.exec(`
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
    VALUES ('any', 'pod', 'action', '@reversible', 'auto', 'system:reversible-default');
  `);
}

describe("create-with-undo — an optional STRICTER preset on the pod default", () => {
  it("baseline: a strict agent with no pod default proposes every create", async () => {
    for (const [s, a] of CREATES)
      expect(await decide(s, a), `${s}.${a}`).toBe("propose");
  });

  it("pod default ON, no posture: creates AND edits execute; disruptive writes propose", async () => {
    await podDefaultOn();
    for (const [s, a] of CREATES)
      expect(await decide(s, a), `${s}.${a}`).toBe("execute");
    expect(await decide("entity", "update")).toBe("execute");
    expect(await decide("document", "update")).toBe("execute");
    for (const [s, a] of [
      ["property_def", "create"],
      ["automation", "create"],
      ["entity", "delete"],
    ] as const)
      expect(await decide(s, a), `${s}.${a}`).toBe("propose");
  });

  it("pod default ON + posture: creates execute; edits, property defs, automations and deletes propose", async () => {
    await podDefaultOn();
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    for (const [s, a] of CREATES)
      expect(await decide(s, a), `${s}.${a}`).toBe("execute");
    for (const [s, a] of PROPOSES)
      expect(await decide(s, a), `${s}.${a}`).toBe("propose");
    // Session orchestration and reads stay instant — the agent's own work loop.
    expect(await decide("focus_session", "update")).toBe("execute");
    expect(await decide("entity", "read")).toBe("execute");
  });

  it("NEVER loosens: pod default OFF + posture ⇒ every write still proposes", async () => {
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    for (const [s, a] of [...CREATES, ...PROPOSES])
      expect(await decide(s, a), `${s}.${a}`).toBe("propose");
  });

  it("the read door reports the posture, and that it is configured", async () => {
    expect(
      (await readAgentGovernance({ db, agentUserId: AGENT }))!.configured
    ).toBe(false);
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    const state = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    expect(state.posture).toBe("create-with-undo");
    expect(state.configured).toBe(true);
    expect(state.writesRequireProposal).toBe(true);
    expect(state.rules.length).toBeGreaterThan(0);
    expect(state.rules.every((r) => r.verdict === "propose")).toBe(true);
    expect(await readAgentGovernance({ db, agentUserId: HUMAN })).toBeNull();
  });

  it("REPLACE semantics: re-applying keeps one rule set; a later autoApproveFor list replaces it", async () => {
    await podDefaultOn();
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    const once = (await readAgentGovernance({ db, agentUserId: AGENT }))!.rules
      .length;
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "create-with-undo",
      createdBy: HUMAN,
    });
    expect(
      (await readAgentGovernance({ db, agentUserId: AGENT }))!.rules.length
    ).toBe(once);

    await syncAutoApproveRules({
      db,
      principalKind: "agent",
      agentUserId: AGENT,
      scopeKind: "pod",
      actions: ["relation.update"],
      createdBy: HUMAN,
    });
    const after = (await readAgentGovernance({ db, agentUserId: AGENT }))!;
    expect(after.rules).toEqual([
      { pattern: "relation.update", verdict: "auto" },
    ]);
    // The posture's propose rules are gone with it — entity.update is back on the pod default.
    expect(await decide("entity", "update")).toBe("execute");
  });
});
