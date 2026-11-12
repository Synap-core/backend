/**
 * A person lets agents run ONE playbook without asking (founder decision,
 * 10 Nov 2026; migration 0420), through the REAL resolver on PGlite: an `auto`
 * rule on `playbook.run` narrowed to that playbook at its version.
 *
 *  - it decides an agent's launch of that playbook at that version, and the
 *    resolution says it NAMES the subject (the one fact that lifts the hold);
 *  - the same playbook at the next version, another playbook, or a launch
 *    that names no subject: the rule matches nothing;
 *  - a broad `playbook.*` auto still decides, but never names the subject.
 *
 * `heldAsDraft` is what the run door passes for an agent's own run (the
 * default then executes into a held draft); without it the default proposes,
 * which is what makes "the rule matched" observable on its own.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveAgentGovernanceDecision } from "./resolve-agent-governance-decision.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../migrations/0420_governance_rule_subject.sql"),
  "utf8"
);

let pg: PGlite;
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const Q = "44444444-4444-4444-8444-444444444444";

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
    CREATE TYPE governance_verdict AS ENUM ('auto','propose','deny');
    -- As before 0420: the two subject columns come from the migration below.
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

async function rule(r: {
  pattern: string;
  subjectId?: string;
  subjectVersion?: number;
}): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO governance_rules
       (principal_kind, scope_kind, target_kind, target_pattern, verdict,
        created_by, target_subject_id, target_subject_version, principal_owner_id)
     VALUES ('any', 'pod', 'action', $1, 'auto', $2, $3, $4, $5)
     RETURNING id`,
    [
      r.pattern,
      `user:${HUMAN}`,
      r.subjectId ?? null,
      r.subjectVersion ?? null,
      r.subjectId ? HUMAN : null,
    ]
  );
  return rows[0]!.id;
}

const launch = (
  subject: { id: string; version: number } | null,
  heldAsDraft = true
) =>
  resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType: "playbook",
    action: "run",
    heldAsDraft,
    ...(subject ? { ruleSubject: { ...subject, forUserId: HUMAN } } : {}),
    preferAgentMetadataAutoApproveFor: true,
  });

describe("migration 0420", () => {
  it("adds the subject columns and the rule's owner, idempotently", async () => {
    await pg.exec(MIGRATION);
    const { rows } = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'governance_rules'
          AND (column_name LIKE 'target_subject_%' OR column_name = 'principal_owner_id')
        ORDER BY column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "principal_owner_id",
      "target_subject_id",
      "target_subject_version",
    ]);
  });
});

describe("a rule naming one playbook at one version — the resolver", () => {
  it("decides the launch of that playbook at that version, and names it", async () => {
    const id = await rule({
      pattern: "playbook.run",
      subjectId: P,
      subjectVersion: 3,
    });
    expect(await launch({ id: P, version: 3 })).toEqual({
      decision: "execute",
      explicitAutoApproveFor: ["playbook.run"],
      governanceRuleId: id,
      namesSubject: true,
    });
    // Without the held-draft default the launch would propose; the rule alone
    // makes it execute.
    expect(await launch({ id: P, version: 3 }, false)).toMatchObject({
      decision: "execute",
      governanceRuleId: id,
      namesSubject: true,
    });
  });

  it("the next version of the same playbook is not covered: the launch asks again", async () => {
    await rule({ pattern: "playbook.run", subjectId: P, subjectVersion: 3 });
    const held = await launch({ id: P, version: 4 });
    expect(held.decision).toBe("execute");
    expect(held).not.toHaveProperty("namesSubject");
    expect(held).not.toHaveProperty("governanceRuleId");
    expect((await launch({ id: P, version: 4 }, false)).decision).toBe(
      "propose"
    );
  });

  it("another playbook, or a launch naming no subject, is not covered", async () => {
    await rule({ pattern: "playbook.run", subjectId: P, subjectVersion: 3 });
    for (const subject of [{ id: Q, version: 3 }, null]) {
      const res = await launch(subject);
      expect(res).not.toHaveProperty("namesSubject");
      expect((await launch(subject, false)).decision).toBe("propose");
    }
  });

  it("a broad auto rule decides, but never names the playbook", async () => {
    const id = await rule({ pattern: "playbook.*" });
    const res = await launch({ id: P, version: 3 });
    expect(res).toMatchObject({ decision: "execute", governanceRuleId: id });
    expect(res).not.toHaveProperty("namesSubject");
  });
});
