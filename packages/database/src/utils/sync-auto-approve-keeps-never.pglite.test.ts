/**
 * A settings allow-list PATCH (`autoApproveFor` on an agent or a space) mirrors
 * its list into `auto` rows by REPLACE: it revokes the rows it wrote before.
 * A person's "never" (a `deny` row) is not one of them, even when it was
 * written without a request (the rules door allows a broad deny): the PATCH
 * must leave it standing, or a refusal disappears with no one taking it back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { syncAutoApproveRules } from "./resolve-agent-governance-decision.js";

let pg: PGlite;
let db: any;

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
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
  `);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM governance_rules;`);
});

async function live(): Promise<{ target_pattern: string; verdict: string }[]> {
  const r = await pg.query<{ target_pattern: string; verdict: string }>(
    `SELECT target_pattern, verdict FROM governance_rules
      WHERE revoked_at IS NULL ORDER BY target_pattern`
  );
  return r.rows;
}

describe("an agent's allow-list PATCH and a standing 'never'", () => {
  it("replaces the old mirrored allows and leaves the deny standing", async () => {
    await pg.exec(`
      INSERT INTO governance_rules
        (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES
        ('agent', '${AGENT}', 'pod', 'action', 'relation.update', 'auto', '${HUMAN}'),
        ('agent', '${AGENT}', 'pod', 'action', 'entity.update', 'deny', '${HUMAN}');
    `);

    await syncAutoApproveRules({
      db,
      principalKind: "agent",
      agentUserId: AGENT,
      scopeKind: "pod",
      actions: ["channel.create"],
      createdBy: HUMAN,
    });

    expect(await live()).toEqual([
      { target_pattern: "channel.create", verdict: "auto" },
      { target_pattern: "entity.update", verdict: "deny" },
    ]);
  });

  it("an empty list clears the allows, never the deny", async () => {
    await pg.exec(`
      INSERT INTO governance_rules
        (principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
      VALUES
        ('agent', '${AGENT}', 'pod', 'action', 'relation.update', 'auto', '${HUMAN}'),
        ('agent', '${AGENT}', 'pod', 'action', 'entity.update', 'deny', '${HUMAN}');
    `);

    await syncAutoApproveRules({
      db,
      principalKind: "agent",
      agentUserId: AGENT,
      scopeKind: "pod",
      actions: [],
      createdBy: HUMAN,
    });

    expect(await live()).toEqual([
      { target_pattern: "entity.update", verdict: "deny" },
    ]);
  });
});
