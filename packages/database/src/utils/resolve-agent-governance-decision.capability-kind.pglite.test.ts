/**
 * A KIND-LIMITED agent capability on a write by id.
 *
 * The grant editor can limit an agent to one kind (`entity.knowledge.update`).
 * An update/delete gate payload usually carries the entity id but no profile
 * slug, so the resolver must read the entity's STORED kind — the same
 * derivation the key-grant check uses — or a kind-limited agent could never
 * update the kind it was given (and could never be told apart from any other).
 *
 * Real `resolveAgentGovernanceDecision` on PGlite, minimal DDL for the tables
 * it reads.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { resolveAgentGovernanceDecision } from "./resolve-agent-governance-decision.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const PERSON = "44444444-4444-4444-8444-444444444444";
const P_KNOWLEDGE = "55555555-5555-4555-8555-555555555555";
const P_PERSON = "66666666-6666-4666-8666-666666666666";

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
      type text,
      profile_id uuid,
      document_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL
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
    INSERT INTO users (id, user_type, agent_metadata) VALUES
      ('${HUMAN}', 'human', null),
      ('${AGENT}', 'agent', '{"capabilities":["entity.knowledge.update"]}');
    INSERT INTO profiles (id, slug) VALUES ('${P_KNOWLEDGE}', 'knowledge'), ('${P_PERSON}', 'person');
    INSERT INTO entities (id, user_id, type, profile_id) VALUES
      ('${NOTE}', '${HUMAN}', 'knowledge', '${P_KNOWLEDGE}'),
      ('${PERSON}', '${HUMAN}', 'person', '${P_PERSON}');
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

const decide = async (entityId: string | null, profileSlug?: string) =>
  (
    await resolveAgentGovernanceDecision({
      db,
      agentUserId: AGENT,
      workspaceId: null,
      subjectType: "entity",
      action: "update",
      subjectEntityId: entityId,
      ...(profileSlug ? { subjectProfileSlug: profileSlug } : {}),
      preferAgentMetadataAutoApproveFor: true,
    })
  ).decision;

describe("kind-limited agent capability — the stored kind is read", () => {
  it("allows an update of the kind it was given, by id alone", async () => {
    expect(await decide(NOTE)).not.toBe("deny");
  });

  it("denies the same update on another kind", async () => {
    expect(await decide(PERSON)).toBe("deny");
  });

  it("the payload's slug still wins when present", async () => {
    expect(await decide(null, "knowledge")).not.toBe("deny");
    expect(await decide(null, "person")).toBe("deny");
  });

  it("no id and no slug → the kind cannot be known → deny (fail closed)", async () => {
    expect(await decide(null)).toBe("deny");
  });
});
