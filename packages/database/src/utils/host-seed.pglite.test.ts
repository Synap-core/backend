/**
 * HOST SEED (computers plan v2 §4 K2, decision c83e0661): a person's auto rule
 * for an agent that runs on an AGENT'S box is written for the box too, so the
 * host step (stricter of agent and computer wins) lets the agent act — and
 * nothing the person did not approve is seeded. Reachability, not shape: each
 * case asserts the decision the ONE resolver returns for the agent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  HOST_SEED_CREATED_BY_PREFIX,
  applyAgentPosture,
  resolveAgentGovernanceDecision,
  revokeAllHostSeedsOn,
  syncAutoApproveRules,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;

let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-222222222222";
/** The person's box that an agent owns ("agent"). */
const BOX = "33333333-3333-4333-8333-333333333333";
/** The person's own laptop ("person"). */
const MAC = "33333333-3333-4333-8333-444444444444";
/** Someone else's agent box. */
const THEIR_BOX = "33333333-3333-4333-8333-555555555555";
/** The person's agent on BOX. */
const AGENT = "22222222-2222-4222-8222-222222222222";
/** A second agent of the person's on BOX, approved for nothing. */
const SECOND = "22222222-2222-4222-8222-333333333333";
/** The person's agent on MAC (a guest there). */
const GUEST = "22222222-2222-4222-8222-444444444444";
/** The person's agent on someone else's box. */
const LODGER = "22222222-2222-4222-8222-555555555555";

/** A genuine widening: not covered by the code floor, so the mirror writes it. */
const ACTION = "channel.create";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb,
      agent_type text,
      host_user_id text,
      created_by_user_id text,
      computer_belongs_to text
    );
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      document_id uuid,
      deleted_at timestamptz
    );
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    CREATE TYPE governance_verdict AS ENUM ('auto','propose','deny');
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      principal_class text,
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
      expires_at timestamptz,
      revoked_reason text
    );
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind text NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind text NOT NULL,
      workspace_id uuid,
      axis text NOT NULL,
      limit_value integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      subject_type text,
      subject_id text
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_user_id text,
      is_agent boolean,
      ceiling_exempt boolean,
      proposal_id uuid,
      timestamp timestamptz NOT NULL DEFAULT now()
    );
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

const META = (t: string) =>
  `'{"agentType":"${t}","writesRequireProposal":true}'::jsonb`;

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM governance_rules;
    DELETE FROM users;
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human'), ('${OTHER}', 'human');
    INSERT INTO users (id, user_type, agent_type, agent_metadata, created_by_user_id, computer_belongs_to) VALUES
      ('${BOX}', 'agent', 'machine', ${META("machine")}, '${HUMAN}', 'agent'),
      ('${MAC}', 'agent', 'machine', ${META("machine")}, '${HUMAN}', 'person'),
      ('${THEIR_BOX}', 'agent', 'machine', ${META("machine")}, '${OTHER}', 'agent');
    INSERT INTO users (id, user_type, agent_type, agent_metadata, created_by_user_id, host_user_id) VALUES
      ('${AGENT}', 'agent', 'claude-code', ${META("claude-code")}, '${HUMAN}', '${BOX}'),
      ('${SECOND}', 'agent', 'codex', ${META("codex")}, '${HUMAN}', '${BOX}'),
      ('${GUEST}', 'agent', 'claude-code', ${META("claude-code")}, '${HUMAN}', '${MAC}'),
      ('${LODGER}', 'agent', 'cursor', ${META("cursor")}, '${HUMAN}', '${THEIR_BOX}');
  `);
});

async function decide(agentUserId: string, key = ACTION): Promise<string> {
  const dot = key.indexOf(".");
  const resolved = await resolveAgentGovernanceDecision({
    db,
    agentUserId,
    workspaceId: null,
    subjectType: key.slice(0, dot),
    action: key.slice(dot + 1),
  });
  return resolved.decision;
}

/** The person approves `actions` for one agent (the settings mirror). */
function approve(agentUserId: string, actions: string[] = [ACTION]) {
  return syncAutoApproveRules({
    db,
    principalKind: "agent",
    agentUserId,
    scopeKind: "pod",
    workspaceId: null,
    actions,
    createdBy: HUMAN,
  });
}

async function seedsOn(computer: string) {
  const { rows } = await pg.query<{
    target_pattern: string;
    verdict: string;
    created_by: string;
    revoked_at: string | null;
  }>(
    `SELECT target_pattern, verdict, created_by, revoked_at FROM governance_rules
     WHERE agent_user_id = $1 AND created_by LIKE $2`,
    [computer, `${HOST_SEED_CREATED_BY_PREFIX}%`]
  );
  return rows;
}

describe("host seed — an approval for an agent covers its box when the box is the agent's", () => {
  it("without the seed the box's own default holds the agent back (the gap it closes)", async () => {
    await pg.exec(
      `UPDATE users SET computer_belongs_to = 'person' WHERE id = '${BOX}'`
    );
    await approve(AGENT);
    expect(await seedsOn(BOX)).toEqual([]);
    expect(await decide(AGENT)).toBe("propose");
  });

  it("the agent's box gets the same rule, named after the agent's rule: the agent may act", async () => {
    await approve(AGENT);
    const [agentRule] = (
      await pg.query<{ id: string }>(
        `SELECT id FROM governance_rules WHERE agent_user_id = $1 AND revoked_at IS NULL`,
        [AGENT]
      )
    ).rows;
    expect(await seedsOn(BOX)).toEqual([
      {
        target_pattern: ACTION,
        verdict: "auto",
        created_by: `${HOST_SEED_CREATED_BY_PREFIX}${agentRule!.id}`,
        revoked_at: null,
      },
    ]);
    expect(await decide(AGENT)).toBe("execute");
  });

  it("seeds nothing the person did not approve", async () => {
    await approve(AGENT);
    // Another agent on the same box still asks: its own pass has no rule.
    expect(await decide(SECOND)).toBe("propose");
    // The seed is exactly the approved action, nothing wider.
    expect(await decide(AGENT, "relation.update")).toBe("propose");
    // A guest on the person's own computer: no seed, the computer holds.
    await approve(GUEST);
    expect(await seedsOn(MAC)).toEqual([]);
    expect(await decide(GUEST)).toBe("propose");
    // The person's agent on SOMEONE ELSE's box: never seeded there.
    await approve(LODGER);
    expect(await seedsOn(THEIR_BOX)).toEqual([]);
    expect(await decide(LODGER)).toBe("propose");
    // A rule for "any" agent is no approval of one agent: no seed.
    await syncAutoApproveRules({
      db,
      principalKind: "any",
      agentUserId: null,
      scopeKind: "pod",
      workspaceId: null,
      actions: ["relation.update"],
      createdBy: HUMAN,
    });
    expect((await seedsOn(BOX)).map((s) => s.target_pattern)).toEqual([ACTION]);
  });

  it("taking the approval back takes the seed back", async () => {
    await approve(AGENT);
    expect(await decide(AGENT)).toBe("execute");
    await approve(AGENT, []);
    expect((await seedsOn(BOX)).every((s) => s.revoked_at !== null)).toBe(true);
    expect(await decide(AGENT)).toBe("propose");
  });

  it("an agent's posture replacing its rules takes their seeds back; the box's own posture never does", async () => {
    await approve(AGENT);
    await applyAgentPosture({
      db,
      agentUserId: BOX,
      posture: "ask-first",
      createdBy: HUMAN,
    });
    expect((await seedsOn(BOX)).filter((s) => !s.revoked_at)).toHaveLength(1);
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: "ask-first",
      createdBy: HUMAN,
    });
    expect((await seedsOn(BOX)).filter((s) => !s.revoked_at)).toHaveLength(0);
  });

  it("a box that stops being the agent's loses every seed", async () => {
    await approve(AGENT);
    expect(await revokeAllHostSeedsOn(db, BOX)).toBe(1);
    expect(await decide(AGENT)).toBe("propose");
  });
});
