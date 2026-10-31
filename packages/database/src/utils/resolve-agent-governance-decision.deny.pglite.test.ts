/**
 * A person's "Never" (founder decision G3, 0381) through the REAL resolver on
 * PGlite: `resolveGovernanceRule` ranks a `deny` row on the same specificity
 * score as every rule, deny winning a tie, and `resolveAgentGovernanceDecision`
 * turns it into a typed refusal above the floors.
 *
 *  - a deny refuses, typed `DENIED_BY_RULE`;
 *  - deny vs auto of the SAME specificity → deny, whichever is newer;
 *  - a MORE specific auto outranks a broad (wildcard) deny → executes;
 *  - a more specific deny outranks a broad auto → refused;
 *  - the floors are never loosened: a delete with a broad auto still
 *    proposes, and a deny on it still refuses (refusing is stricter);
 *  - a posture change never takes a "Never" back;
 *  - a person acting as themselves is never refused (agents only).
 *
 * Minimal DDL for the tables the resolver reads (as the capability-kind test).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  applyAgentPosture,
  resolveAgentGovernanceDecision,
  resolveGovernanceRule,
} from "./resolve-agent-governance-decision.js";
import { DENIED_BY_RULE } from "@synap/governance-policy";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../migrations/0381_governance_deny_and_request_later.sql"),
  "utf8"
);

let pg: PGlite;
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb,
      agent_type text,
      host_user_id text
    );
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      type text,
      profile_id uuid,
      document_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL
    );
    CREATE TABLE proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
    -- As 0215 created it: the deny value comes from 0381 below.
    CREATE TYPE governance_verdict AS ENUM ('auto','propose');
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
      expires_at timestamptz
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
  await pg.exec(MIGRATION);
  await pg.exec(`
    INSERT INTO users (id, user_type, agent_metadata) VALUES
      ('${HUMAN}', 'human', null),
      ('${AGENT}', 'agent', '{}');
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM governance_rules`);
});

/** One active rule; `minutesAgo` orders ties. */
async function rule(r: {
  principal: "agent" | "any";
  pattern: string;
  verdict: "auto" | "propose" | "deny";
  minutesAgo?: number;
  sourceProposal?: boolean;
}) {
  await pg.query(
    `INSERT INTO governance_rules
       (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern,
        verdict, created_by, created_at, source_proposal_id)
     VALUES ($1, $2, 'pod', 'action', $3, $4, $5,
             now() - ($6 || ' minutes')::interval, $7)`,
    [
      r.principal,
      r.principal === "agent" ? AGENT : null,
      r.pattern,
      r.verdict,
      `user:${HUMAN}`,
      String(r.minutesAgo ?? 0),
      r.sourceProposal ? "33333333-3333-4333-8333-333333333333" : null,
    ]
  );
}

const decide = (action: string, subjectType = "entity") =>
  resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType,
    action,
    preferAgentMetadataAutoApproveFor: true,
  });

describe("migration 0381 — the deny value", () => {
  it("adds 'deny' to governance_verdict, idempotently", async () => {
    await pg.exec(MIGRATION);
    const { rows } = await pg.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::governance_verdict))::text AS v`
    );
    expect(rows.map((r) => r.v)).toEqual(["auto", "propose", "deny"]);
  });
});

describe("a person's Never — the resolver", () => {
  it("a deny rule refuses the write, typed DENIED_BY_RULE", async () => {
    expect((await decide("update")).decision).toBe("execute");
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
    });
    const res = await decide("update");
    expect(res).toMatchObject({ decision: "deny", reasonCode: DENIED_BY_RULE });
    expect(res.decision === "deny" && res.reason).toMatch(/^DENIED_BY_RULE:/);
  });

  it("deny beats auto of the same specificity, the auto newer", async () => {
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
      minutesAgo: 10,
    });
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "auto",
      minutesAgo: 1,
    });
    expect((await decide("update")).decision).toBe("deny");
  });

  it("deny beats auto of the same specificity, the deny newer", async () => {
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "auto",
      minutesAgo: 10,
    });
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
      minutesAgo: 1,
    });
    expect((await decide("update")).decision).toBe("deny");
  });

  it("a more specific auto outranks a broad (wildcard) deny", async () => {
    await rule({ principal: "agent", pattern: "*", verdict: "deny" });
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "auto",
      minutesAgo: 5,
    });
    expect((await decide("update")).decision).toBe("execute");
    // Everything else stays refused by the broad deny.
    expect((await decide("create")).decision).toBe("deny");
  });

  it("a more specific deny outranks a broad auto", async () => {
    await rule({ principal: "any", pattern: "*", verdict: "auto" });
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
      minutesAgo: 5,
    });
    expect((await decide("update")).decision).toBe("deny");
    expect((await decide("create")).decision).toBe("execute");
  });

  it("the winning row is the deny one (the store's own answer)", async () => {
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "auto",
    });
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
      minutesAgo: 30,
    });
    const match = await resolveGovernanceRule({
      db,
      agentUserId: AGENT,
      workspaceId: null,
      subjectType: "entity",
      action: "update",
    });
    expect(match?.verdict).toBe("deny");
  });
});

describe("a person's Never — agents only", () => {
  it("a person acting as themselves is never refused, even by an any-principal deny", async () => {
    await rule({ principal: "any", pattern: "entity.update", verdict: "deny" });
    // The same rule refuses the agent…
    expect((await decide("update")).decision).toBe("deny");
    // …and never the person: the resolver hands them back as not-agent, and
    // the human path grants on RBAC alone.
    const res = await resolveAgentGovernanceDecision({
      db,
      agentUserId: HUMAN,
      workspaceId: null,
      subjectType: "entity",
      action: "update",
      preferAgentMetadataAutoApproveFor: true,
    });
    expect(res.decision).toBe("not-agent");
  });
});

describe("a person's Never — the floors are never loosened", () => {
  it("a delete with a broad auto still proposes (the floor holds)", async () => {
    await rule({ principal: "agent", pattern: "*", verdict: "auto" });
    expect((await decide("delete")).decision).toBe("propose");
  });

  it("a deny on a floored delete refuses (stricter than the floor)", async () => {
    await rule({
      principal: "agent",
      pattern: "entity.delete",
      verdict: "deny",
    });
    expect(await decide("delete")).toMatchObject({
      decision: "deny",
      reasonCode: DENIED_BY_RULE,
    });
  });

  it("a deny on an admin action refuses", async () => {
    await rule({
      principal: "agent",
      pattern: "workspace.delete",
      verdict: "deny",
    });
    expect((await decide("delete", "workspace")).decision).toBe("deny");
  });
});

describe("a person's Never — postures never take it back", () => {
  it("applying a posture keeps a pod-wide deny of this agent", async () => {
    await rule({
      principal: "agent",
      pattern: "entity.update",
      verdict: "deny",
    });
    await applyAgentPosture({
      db,
      agentUserId: AGENT,
      posture: null,
      createdBy: HUMAN,
    });
    expect((await decide("update")).decision).toBe("deny");
  });
});
