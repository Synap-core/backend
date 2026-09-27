/**
 * Text tiers (b) — the I/O half of the entity-body lane, on real Postgres.
 *
 * A `document.update` by an agent on the BODY of a human-owned entity must
 * resolve exactly as an `entity.update` of that entity would — the classification
 * (`isHumanOwnedEntityBody`) AND the rule store (queried on the lane key). The
 * engine half is covered in @synap/governance-policy `entity-body-lane.test.ts`.
 *
 * Minimal DDL for the tables the resolver reads: users, entities (id, user_id,
 * document_id, deleted_at), governance_rules, governance_ceilings, events.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  isHumanOwnedEntityBody,
  resolveAgentGovernanceDecision,
} from "./resolve-agent-governance-decision.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const HUMAN_BODY = "33333333-3333-4333-8333-333333333333";
const AGENT_BODY = "44444444-4444-4444-8444-444444444444";
const STANDALONE = "55555555-5555-4555-8555-555555555555";
const DELETED_BODY = "66666666-6666-4666-8666-666666666666";

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
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human'), ('${AGENT}', 'agent');
    INSERT INTO entities (user_id, document_id) VALUES ('${HUMAN}', '${HUMAN_BODY}');
    INSERT INTO entities (user_id, document_id) VALUES ('${AGENT}', '${AGENT_BODY}');
    INSERT INTO entities (user_id, document_id, deleted_at) VALUES ('${HUMAN}', '${DELETED_BODY}', now());
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM governance_rules;`);
});

async function decide(
  subjectType: string,
  action: string,
  subjectDocumentId?: string
): Promise<string> {
  const resolved = await resolveAgentGovernanceDecision({
    db,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType,
    action,
    preferAgentMetadataAutoApproveFor: true,
    ...(subjectDocumentId ? { subjectDocumentId } : {}),
  });
  return resolved.decision;
}

async function rule(pattern: string, verdict: "auto" | "propose") {
  await pg.exec(`
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
    VALUES ('any', 'pod', 'action', '${pattern}', '${verdict}', 'test');
  `);
}

describe("isHumanOwnedEntityBody", () => {
  it("is true only for a live human-owned entity's body", async () => {
    expect(await isHumanOwnedEntityBody(db, HUMAN_BODY)).toBe(true);
    expect(await isHumanOwnedEntityBody(db, AGENT_BODY)).toBe(false);
    expect(await isHumanOwnedEntityBody(db, STANDALONE)).toBe(false);
    expect(await isHumanOwnedEntityBody(db, DELETED_BODY)).toBe(false);
  });
});

describe("resolveAgentGovernanceDecision — entity-body lane", () => {
  it("default pod: a human body's document.update executes like entity.update; others propose", async () => {
    expect(await decide("entity", "update")).toBe("execute");
    expect(await decide("document", "update", HUMAN_BODY)).toBe("execute");
    expect(await decide("document", "update", AGENT_BODY)).toBe("propose");
    expect(await decide("document", "update", STANDALONE)).toBe("propose");
    expect(await decide("document", "update")).toBe("propose");
  });

  it("a propose rule on entity.update reaches the body too (rules read on the lane key)", async () => {
    await rule("entity.update", "propose");
    expect(await decide("entity", "update")).toBe("propose");
    expect(await decide("document", "update", HUMAN_BODY)).toBe("propose");
  });

  it("a document.update auto rule does not decide a body — the entity lane does", async () => {
    await rule("entity.update", "propose");
    await rule("document.update", "auto");
    expect(await decide("document", "update", HUMAN_BODY)).toBe("propose");
    // …while a standalone document still follows its own lane's rule.
    expect(await decide("document", "update", STANDALONE)).toBe("execute");
  });

  it("the floor stays: a delete on a human body still proposes under an auto rule", async () => {
    await rule("document.*", "auto");
    await rule("entity.*", "auto");
    expect(await decide("document", "delete", HUMAN_BODY)).toBe("propose");
  });
});
