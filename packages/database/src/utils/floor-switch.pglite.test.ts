/**
 * The floors a pod may switch, on real Postgres: the REAL seed migration
 * (0451), the REAL class-row store (`setPodClassDefault`) and the REAL
 * resolver + engine (`resolveAgentGovernanceDecision`), so what is asserted
 * is the decision a door gets. And the pod number settings 0451 seeds.
 *
 * Rows where a naive reading disagrees: a person's `auto` rule on the write
 * (the floor beats it while the switch is off, decides once it is on); the
 * switch on with no rule (still a proposal: the row never makes a write auto
 * by itself); a 2.09 write outside the family (`cell.define`) and the other
 * family (`profile.create`), which the structure switch never opens; the
 * migration run again after a person changed a switch or a setting (kept).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { resolveAgentGovernanceDecision } from "./resolve-agent-governance-decision.js";
import {
  readPodClassDefault,
  setPodClassDefault,
} from "./reversible-default.js";
import { readPodNumberSetting, setPodNumberSetting } from "./pod-settings.js";

const M0451 = readFileSync(
  fileURLToPath(
    new URL(
      "../../migrations/0451_governance_floor_switches.sql",
      import.meta.url
    )
  ),
  "utf-8"
);

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const STRUCTURE = "@agent-builds-structure";
const KINDS = "@agent-defines-kinds";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle over PGlite
let db: any;

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
      document_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE governance_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_kind text NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind text NOT NULL,
      workspace_id uuid,
      target_kind text NOT NULL,
      target_pattern text NOT NULL,
      target_profile text,
      verdict text NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      revoked_reason text,
      target_subject_id uuid,
      target_subject_version integer,
      principal_owner_id text
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
    CREATE TABLE config_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      capability_id uuid,
      scope_kind text NOT NULL,
      scope_ref text,
      key text NOT NULL,
      value jsonb NOT NULL,
      shape jsonb,
      workspace_id uuid,
      source text NOT NULL DEFAULT 'user',
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      supersedes_id uuid
    );
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_metadata) VALUES ('${AGENT}', 'agent', '{}');
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM governance_rules; DELETE FROM config_settings;`);
  await pg.exec(M0451);
});

async function decide(key: string) {
  const dot = key.indexOf(".");
  return resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType: key.slice(0, dot),
    action: key.slice(dot + 1),
    preferAgentMetadataAutoApproveFor: true,
  });
}

async function personRuleAuto(pattern: string) {
  await pg.exec(`
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
    VALUES ('any', 'pod', 'action', '${pattern}', 'auto', 'user:${HUMAN}');
  `);
}

describe("the floor switches, seeded off", () => {
  it("both families are off, and the floor beats a person's auto rule", async () => {
    for (const family of [STRUCTURE, KINDS] as const) {
      expect((await readPodClassDefault(db, family)).enabled, family).toBe(
        false
      );
    }
    await personRuleAuto("automation.create");
    await personRuleAuto("profile.create");
    expect(await decide("automation.create")).toMatchObject({
      decision: "propose",
    });
    expect(await decide("profile.create")).toMatchObject({
      decision: "propose",
    });
  });

  it("switched on, the floor yields: the person's rule decides", async () => {
    await personRuleAuto("automation.create");
    await personRuleAuto("profile.create");
    await setPodClassDefault(db, {
      pattern: STRUCTURE,
      enabled: true,
      userId: HUMAN,
    });
    expect(await decide("automation.create")).toMatchObject({
      decision: "execute",
    });
    // The other family stays floored.
    expect(await decide("profile.create")).toMatchObject({
      decision: "propose",
    });
    await setPodClassDefault(db, {
      pattern: KINDS,
      enabled: true,
      userId: HUMAN,
    });
    expect(await decide("profile.create")).toMatchObject({
      decision: "execute",
    });
  });

  it("switched on with no rule, it is still a proposal: never a blanket auto", async () => {
    await setPodClassDefault(db, {
      pattern: STRUCTURE,
      enabled: true,
      userId: HUMAN,
    });
    expect(await decide("playbook.create")).toMatchObject({
      decision: "propose",
    });
  });

  it("a 2.09 write outside the family stays floored", async () => {
    await personRuleAuto("cell.define");
    await setPodClassDefault(db, {
      pattern: STRUCTURE,
      enabled: true,
      userId: HUMAN,
    });
    expect(await decide("cell.define")).toMatchObject({ decision: "propose" });
  });

  it("switched off again, the floor holds; running 0451 again changes no switch", async () => {
    await personRuleAuto("automation.create");
    await setPodClassDefault(db, {
      pattern: STRUCTURE,
      enabled: true,
      userId: HUMAN,
    });
    await pg.exec(M0451);
    expect((await readPodClassDefault(db, STRUCTURE)).enabled).toBe(true);
    await setPodClassDefault(db, {
      pattern: STRUCTURE,
      enabled: false,
      userId: HUMAN,
    });
    await pg.exec(M0451);
    expect((await readPodClassDefault(db, STRUCTURE)).enabled).toBe(false);
    expect(await decide("automation.create")).toMatchObject({
      decision: "propose",
    });
  });
});

describe("the pod number settings", () => {
  it("are seeded at today's values, kept when a person changed them", async () => {
    expect(
      await readPodNumberSetting(db, "governance.own_work_fresh_hours")
    ).toBe(24);
    expect(
      await readPodNumberSetting(db, "governance.project_evidence_min")
    ).toBe(5);
    await setPodNumberSetting(db, {
      key: "governance.project_evidence_min",
      value: 3,
      userId: HUMAN,
    });
    await pg.exec(M0451);
    expect(
      await readPodNumberSetting(db, "governance.project_evidence_min")
    ).toBe(3);
  });

  it("refuse a value out of range; a missing row reads as the default", async () => {
    await expect(
      setPodNumberSetting(db, {
        key: "governance.own_work_fresh_hours",
        value: 0,
        userId: HUMAN,
      })
    ).rejects.toThrow(RangeError);
    await pg.exec(`DELETE FROM config_settings;`);
    expect(
      await readPodNumberSetting(db, "governance.own_work_fresh_hours")
    ).toBe(24);
  });
});
