/**
 * "Reversible writes act" — the pod default, on real Postgres.
 *
 * Drives the REAL migration file (0282) and the REAL resolver: a strict agent
 * (`writesRequireProposal: true`, how every existing BYOA agent was minted)
 * acts directly on a reversible write once the seeded row exists, still
 * proposes a delete / a schema write, and an anonymous write never gets the
 * lane. The toggle writer and the settings mirror are covered on the same rows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { REVERSIBILITY_DOOR_CLASS } from "@synap/governance-policy";
import {
  dryRunAgentGovernanceDecision,
  resolveAgentGovernanceDecision,
  resolveGovernanceRule,
  syncAutoApproveRules,
} from "./resolve-agent-governance-decision.js";
import {
  readReversibleDefault,
  setReversibleDefault,
} from "./reversible-default.js";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../migrations/0282_governance_reversible_default.sql",
      import.meta.url
    )
  ),
  "utf-8"
);

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const STRICT_AGENT = "22222222-2222-4222-8222-222222222222";

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
});

async function decide(subjectType: string, action: string): Promise<string> {
  const resolved = await resolveAgentGovernanceDecision({
    db,
    agentUserId: STRICT_AGENT,
    workspaceId: null,
    subjectType,
    action,
    preferAgentMetadataAutoApproveFor: true,
  });
  return resolved.decision;
}

describe("migration 0282 — the pod default is seeded ON, once", () => {
  it("seeds one active auto row; re-running adds nothing", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM governance_rules WHERE target_pattern = '@reversible'`
    );
    expect(rows[0]!.n).toBe(1);
    expect((await readReversibleDefault(db)).enabled).toBe(true);
  });

  it("a pod switched OFF stays off when the migration re-runs", async () => {
    await pg.exec(MIGRATION);
    await setReversibleDefault(db, { enabled: false, userId: HUMAN });
    await pg.exec(MIGRATION);
    expect((await readReversibleDefault(db)).enabled).toBe(false);
  });
});

describe("a STRICT agent under the pod default", () => {
  it("before the default: every write proposes (rung 5)", async () => {
    expect(await decide("entity", "update")).toBe("propose");
    expect(await decide("entity", "create")).toBe("propose");
  });

  it("with the default: reversible writes execute, disruptive ones propose", async () => {
    await pg.exec(MIGRATION);
    expect(await decide("entity", "update")).toBe("execute");
    expect(await decide("entity", "create")).toBe("execute");
    expect(await decide("document", "update")).toBe("execute");
    expect(await decide("relation", "update")).toBe("execute");
    // Floors and disruptive classes are untouched.
    expect(await decide("entity", "delete")).toBe("propose");
    expect(await decide("property_def", "create")).toBe("propose");
    expect(await decide("share", "create")).toBe("propose");
    expect(await decide("tool", "create")).toBe("propose");
  });

  it("the receipt names the class row that decided", async () => {
    await pg.exec(MIGRATION);
    const { ruleId } = await readReversibleDefault(db);
    const resolved = await resolveAgentGovernanceDecision({
      db,
      agentUserId: STRICT_AGENT,
      workspaceId: null,
      subjectType: "entity",
      action: "update",
      preferAgentMetadataAutoApproveFor: true,
    });
    expect(resolved).toMatchObject({
      decision: "execute",
      governanceRuleId: ruleId,
    });
  });

  it("an agent explicitly set stricter (its own propose rule) outranks the default", async () => {
    await pg.exec(MIGRATION);
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('agent', '${STRICT_AGENT}', 'pod', 'action', 'entity.update', 'propose', 'user:${HUMAN}');
    `);
    expect(await decide("entity", "update")).toBe("propose");
    expect(await decide("entity", "create")).toBe("execute");
  });

  it("switched off from Settings: back to proposing", async () => {
    await pg.exec(MIGRATION);
    await setReversibleDefault(db, { enabled: false, userId: HUMAN });
    expect(await decide("entity", "update")).toBe("propose");
    const on = await setReversibleDefault(db, { enabled: true, userId: HUMAN });
    expect(on.enabled).toBe(true);
    expect(await decide("entity", "update")).toBe("execute");
  });
});

describe("attribution + the settings mirror", () => {
  it("an anonymous write (no agent) never matches the class row", async () => {
    await pg.exec(MIGRATION);
    expect(
      await resolveGovernanceRule({
        db,
        agentUserId: null,
        subjectType: "entity",
        action: "update",
      })
    ).toBeUndefined();
    expect(
      await resolveGovernanceRule({
        db,
        agentUserId: STRICT_AGENT,
        subjectType: "entity",
        action: "update",
      })
    ).toMatchObject({ verdict: "auto", matchedPattern: "@reversible" });
  });

  it("a pod autoApproveFor mirror PATCH never switches the default off", async () => {
    await pg.exec(MIGRATION);
    await syncAutoApproveRules({
      db,
      principalKind: "any",
      scopeKind: "pod",
      actions: ["channel.create"],
      createdBy: HUMAN,
    });
    expect((await readReversibleDefault(db)).enabled).toBe(true);
  });
});

/**
 * The PREVIEW must say what the WRITE does. Every preview UI (Settings › Agents
 * "Effective policy", Trust rules "Test policy") holds an EVENT KEY
 * (`entity.create`) and sends it as `action` with no subject. The dry-run used
 * to resolve that as the key `.entity.create`, which nothing matches — so the
 * page read "Requires proposal · rung default" while the pod auto-applied the
 * same write via `@reversible` (live, 2026-09-28).
 */
describe("the governance preview agrees with the real write", () => {
  async function preview(eventKey: string) {
    return dryRunAgentGovernanceDecision({
      db,
      agentUserId: STRICT_AGENT,
      workspaceId: null,
      action: eventKey,
      door: "chat",
    });
  }

  it("entity.create previews as auto via @reversible; entity.delete as propose", async () => {
    await pg.exec(MIGRATION);
    // The live agent also carried an (unmatched) earned rule; it must not
    // change the answer.
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES ('agent', '${STRICT_AGENT}', 'pod', 'action', 'entity.entity.create', 'auto', 'user:${HUMAN}');
    `);
    const { ruleId } = await readReversibleDefault(db);

    const create = await preview("entity.create");
    expect(create).toMatchObject({
      outcome: "auto",
      rung: "governance-rule",
      winningRule: { ruleId, matchedPattern: "@reversible", verdict: "auto" },
    });
    expect(create.reason).toContain("@reversible");

    const del = await preview("entity.delete");
    expect(del.outcome).toBe("propose");
    expect(del.rung).not.toBe("default");
  });

  it("for EVERY classified door, preview(eventKey) === the resolver's verdict on the real pair", async () => {
    await pg.exec(MIGRATION);
    // Derived, not hand-listed: a new door joins the check by existing.
    const doors = Object.keys(REVERSIBILITY_DOOR_CLASS);
    expect(doors.length).toBeGreaterThan(50);
    let autos = 0;
    for (const door of doors) {
      const [subjectType, action] = door.split("/") as [string, string];
      const real = await decide(subjectType, action);
      const shown = await preview(`${subjectType}.${action}`);
      expect({ door, outcome: shown.outcome }).toEqual({
        door,
        outcome: real === "execute" ? "auto" : "propose",
      });
      if (shown.outcome === "auto") autos++;
    }
    // Non-vacuity: the reversible lane really fired through the preview.
    expect(autos).toBeGreaterThan(10);
  });
});
