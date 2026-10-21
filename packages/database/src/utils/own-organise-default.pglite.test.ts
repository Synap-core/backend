/**
 * FB1020 B3 — "an agent tidies its own fresh work", on real Postgres.
 *
 * Drives the REAL seed migrations (0282 `@reversible`, 0346b `@own-organise`)
 * and the REAL resolver + engine (`resolveAgentGovernanceDecision`), so what is
 * asserted is the decision a door gets. The door's PROOF (`ownWorkOrganise`)
 * is an input here; whether it is true is `isOwnFreshWork` (api suites).
 *
 * The discriminating input: `focus_session.update` is REVERSIBLE, so the
 * `@reversible` row matches it. With the own-organise row switched OFF, a
 * proven session filing must still PROPOSE — a resolver that let any auto row
 * through would execute it. And with no proof, the class row must not match.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { resolveAgentGovernanceDecision } from "./resolve-agent-governance-decision.js";
import {
  readOwnOrganiseDefault,
  setOwnOrganiseDefault,
} from "./reversible-default.js";

const read = (f: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url)),
    "utf-8"
  );
const REVERSIBLE = read("0282_governance_reversible_default.sql");
const OWN_ORGANISE = read("0346b_governance_own_organise_default.sql");

let pg: PGlite;

let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const STRICT_AGENT = "22222222-2222-4222-8222-222222222222";

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
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TYPE governance_target AS ENUM ('action','profile','capability','connection');
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
      proposal_id uuid,
      timestamp timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pg.exec(`
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_metadata)
      VALUES ('${STRICT_AGENT}', 'agent', '{"writesRequireProposal": true}');
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM governance_rules;`);
  await pg.exec(REVERSIBLE);
  await pg.exec(OWN_ORGANISE);
});

async function decide(
  key: string,
  facts: {
    ownWorkOrganise?: boolean;
    forcePropose?: boolean;
    lifecycleMove?: { intoTerminal: boolean; humanOnly: boolean };
  } = {}
) {
  const dot = key.indexOf(".");
  return resolveAgentGovernanceDecision({
    db,
    agentUserId: STRICT_AGENT,
    workspaceId: null,
    subjectType: key.slice(0, dot),
    action: key.slice(dot + 1),
    preferAgentMetadataAutoApproveFor: true,
    ...facts,
  });
}
const proven = { ownWorkOrganise: true, forcePropose: false };
const TERMINAL = { intoTerminal: true, humanOnly: false };

describe("the own-organise default, seeded ON", () => {
  it("is on, and a proven organise write executes under ITS rule", async () => {
    const { enabled, ruleId } = await readOwnOrganiseDefault(db);
    expect(enabled).toBe(true);
    for (const key of ["project.file_entities", "focus_session.update"]) {
      expect(await decide(key, proven)).toMatchObject({
        decision: "execute",
        governanceRuleId: ruleId,
      });
    }
    expect(
      await decide("entity.transition", { ...proven, lifecycleMove: TERMINAL })
    ).toMatchObject({ decision: "execute", governanceRuleId: ruleId });
  });

  it("without the proof nothing changes: a filing proposes, a plain update is @reversible's", async () => {
    expect(
      await decide("project.file_entities", { forcePropose: true })
    ).toMatchObject({ decision: "propose" });
    const { ruleId } = await readOwnOrganiseDefault(db);
    const plain = await decide("focus_session.update");
    expect(plain.decision).toBe("execute");
    expect(plain).not.toMatchObject({ governanceRuleId: ruleId });
    expect(
      await decide("entity.transition", { lifecycleMove: TERMINAL })
    ).toMatchObject({ decision: "propose" });
  });

  it("switched OFF: every proven organise write proposes — @reversible never widens one", async () => {
    await setOwnOrganiseDefault(db, { enabled: false, userId: HUMAN });
    expect((await readOwnOrganiseDefault(db)).enabled).toBe(false);
    expect(await decide("focus_session.update", proven)).toMatchObject({
      decision: "propose",
    });
    expect(await decide("project.file_entities", proven)).toMatchObject({
      decision: "propose",
    });
    expect(
      await decide("entity.transition", { ...proven, lifecycleMove: TERMINAL })
    ).toMatchObject({ decision: "propose" });
  });

  it("a person's own `propose` rule on the write outranks the class", async () => {
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'action', 'project.file_entities', 'propose', 'user:${HUMAN}');
    `);
    expect(await decide("project.file_entities", proven)).toMatchObject({
      decision: "propose",
    });
  });

  it("a proof on a write outside the class is refused (delete, track start)", async () => {
    expect(await decide("entity.delete", proven)).toMatchObject({
      decision: "propose",
    });
    expect(await decide("track.create", proven)).toMatchObject({
      decision: "propose",
    });
  });
});
