/**
 * REAL-POSTGRES (PGlite) proof for migration 0320 (MACHINE-IDENTITY-PLAN W1)
 * and the resolver changes it carries:
 *   - the file runs inside ONE transaction (as the migrator runs it), twice;
 *   - existing agents keep their (person, type) singleton — host NULL is '';
 *   - one agent per (person, type, COMPUTER): the same type on two computers
 *     coexists, twice on one computer is refused; computers are not unique;
 *   - a `class` row must name its class (CHECK);
 *   - HOST STEP: an agent never acts looser than its computer (stricter wins);
 *   - CLASS RANK: agent (2) > class (1) > any (0), for rules and ceilings.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  resolveAgentGovernanceDecision,
  resolveDailyWriteCeiling,
} from "./utils/resolve-agent-governance-decision.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0320 = readFileSync(
  resolve(HERE, "../migrations/0320_machine_identity.sql"),
  "utf8"
);

const HUMAN = "11111111-1111-4111-8111-111111111111";
const LEGACY_CC = "22222222-2222-4222-8222-222222222222";
const DEVBOX = "33333333-3333-4333-8333-333333333333";
const DEVBOX_CC = "44444444-4444-4444-8444-444444444444";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_metadata jsonb,
      agent_type text,
      agent_template text,
      is_personal_agent boolean NOT NULL DEFAULT false,
      created_by_user_id text
    );
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text, document_id uuid, deleted_at timestamptz
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
      axis text NOT NULL,
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      limit_value integer NOT NULL,
      created_by text NOT NULL DEFAULT 'x',
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      -- 0330 (the caps fold): read by the one ceiling resolver.
      subject_type text,
      subject_id text
    );
    CREATE TABLE events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_user_id text, is_agent boolean, proposal_id uuid,
      timestamp timestamptz NOT NULL DEFAULT now()
    );
    -- 0228's index, as a live pod has it.
    CREATE UNIQUE INDEX idx_users_service_agent_creator_type_unique
      ON users (created_by_user_id, agent_type)
      WHERE user_type = 'agent' AND agent_template IS NULL
        AND COALESCE(is_personal_agent, false) = false
        AND created_by_user_id IS NOT NULL AND agent_type IS NOT NULL;
    INSERT INTO users (id, user_type) VALUES ('${HUMAN}', 'human');
    INSERT INTO users (id, user_type, agent_type, created_by_user_id)
      VALUES ('${LEGACY_CC}', 'agent', 'claude-code', '${HUMAN}');
  `);
  // As the migrator runs it: one transaction. Then a re-run is a no-op.
  await pg.exec(`BEGIN;\n${M0320}\nCOMMIT;`);
  await pg.exec(`BEGIN;\n${M0320}\nCOMMIT;`);
  db = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

const insertAgent = (id: string, type: string, host: string | null) =>
  pg.query(
    `INSERT INTO users (id, user_type, agent_type, created_by_user_id, host_user_id)
     VALUES ($1, 'agent', $2, $3, $4)`,
    [id, type, HUMAN, host]
  );

describe("migration 0320 — the model", () => {
  it("keeps the existing agent untouched (no computer)", async () => {
    const { rows } = await pg.query<{ host_user_id: string | null }>(
      `SELECT host_user_id FROM users WHERE id = $1`,
      [LEGACY_CC]
    );
    expect(rows[0]!.host_user_id).toBeNull();
  });

  it("one agent per (person, type, computer)", async () => {
    await insertAgent(DEVBOX, "machine", null);
    // A second computer of the same person is fine: computers are not unique.
    await insertAgent("55555555-5555-4555-8555-555555555555", "machine", null);
    // Same type, no computer, twice: refused exactly as before 0320.
    await expect(
      insertAgent("66666666-6666-4666-8666-666666666666", "claude-code", null)
    ).rejects.toThrow(/duplicate key|unique/i);
    // Same type ON devbox: a distinct principal.
    await insertAgent(DEVBOX_CC, "claude-code", DEVBOX);
    // Twice on devbox: refused.
    await expect(
      insertAgent("77777777-7777-4777-8777-777777777777", "claude-code", DEVBOX)
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("a class row must name its class, and only a class row may", async () => {
    await expect(
      pg.exec(`INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
               VALUES ('class', 'pod', 'action', '*', 'propose', 'x')`)
    ).rejects.toThrow(/principal_class_check/);
    await expect(
      pg.exec(`INSERT INTO governance_rules (principal_kind, principal_class, scope_kind, target_kind, target_pattern, verdict, created_by)
               VALUES ('any', 'machine', 'pod', 'action', '*', 'propose', 'x')`)
    ).rejects.toThrow(/principal_class_check/);
  });
});

const rule = (
  principal: "agent" | "any" | "class",
  verdict: "auto" | "propose",
  opts: { agent?: string; cls?: string; pattern?: string; ageMin?: number } = {}
) =>
  pg.query(
    `INSERT INTO governance_rules (principal_kind, agent_user_id, principal_class, scope_kind, target_kind, target_pattern, verdict, created_by, created_at)
     VALUES ($1, $2, $3, 'pod', 'action', $4, $5, 'user:x', now() - ($6 || ' minutes')::interval)`,
    [
      principal,
      opts.agent ?? null,
      opts.cls ?? null,
      opts.pattern ?? "entity.update",
      verdict,
      String(opts.ageMin ?? 0),
    ]
  );

const decide = async (agentUserId: string) =>
  (
    await resolveAgentGovernanceDecision({
      db,
      agentUserId,
      workspaceId: null,
      subjectType: "entity",
      action: "update",
      preferAgentMetadataAutoApproveFor: true,
    })
  ).decision;

describe("host step — stricter wins", () => {
  beforeEach(async () => {
    await pg.exec(`DELETE FROM governance_rules; DELETE FROM governance_ceilings;`);
  });

  it("the computer asks first ⇒ its agent asks first, even with its own auto rule", async () => {
    await rule("agent", "auto", { agent: DEVBOX_CC });
    await rule("agent", "propose", { agent: DEVBOX });
    expect(await decide(DEVBOX_CC)).toBe("propose");
  });

  it("a computer that acts lets its agent's own verdict stand", async () => {
    await rule("agent", "auto", { agent: DEVBOX_CC });
    await rule("agent", "auto", { agent: DEVBOX });
    expect(await decide(DEVBOX_CC)).toBe("execute");
  });

  it("never looser: an agent that asks first keeps asking under an acting computer", async () => {
    await rule("agent", "propose", { agent: DEVBOX_CC });
    await rule("agent", "auto", { agent: DEVBOX });
    expect(await decide(DEVBOX_CC)).toBe("propose");
  });

  it("an agent with no computer is unaffected by any computer's rules", async () => {
    await rule("agent", "auto", { agent: LEGACY_CC });
    await rule("agent", "propose", { agent: DEVBOX });
    expect(await decide(LEGACY_CC)).toBe("execute");
  });
});

describe("class rank — agent > class > any", () => {
  beforeEach(async () => {
    await pg.exec(`DELETE FROM governance_rules; DELETE FROM governance_ceilings;`);
  });

  it("'for all computers' outranks 'for all agents'", async () => {
    // The class row is OLDER: a tie would go to the newer `any` row, so only
    // the rank can make the class row win.
    await rule("class", "propose", { cls: "machine", ageMin: 5 });
    await rule("any", "auto");
    expect(await decide(DEVBOX)).toBe("propose");
  });

  it("a computer's own row outranks 'for all computers'", async () => {
    await rule("class", "propose", { cls: "machine" });
    await rule("agent", "auto", { agent: DEVBOX });
    expect(await decide(DEVBOX)).toBe("execute");
  });

  it("a class row never reaches an agent of another class", async () => {
    await rule("any", "auto");
    await rule("class", "propose", { cls: "machine" });
    expect(await decide(LEGACY_CC)).toBe("execute");
  });

  it("…but reaches an agent hosted by a computer (through the host step)", async () => {
    await rule("any", "auto");
    await rule("class", "propose", { cls: "machine" });
    expect(await decide(DEVBOX_CC)).toBe("propose");
  });

  it("ceilings rank the same way", async () => {
    await pg.exec(`
      INSERT INTO governance_ceilings (axis, principal_kind, principal_class, scope_kind, limit_value, created_at) VALUES ('daily_write_count', 'class', 'machine', 'pod', 7, now() - interval '1 minute');
      INSERT INTO governance_ceilings (axis, principal_kind, scope_kind, limit_value) VALUES ('daily_write_count', 'any', 'pod', 50);
    `);
    expect(await resolveDailyWriteCeiling({ db, agentUserId: DEVBOX })).toBe(7);
    expect(await resolveDailyWriteCeiling({ db, agentUserId: LEGACY_CC })).toBe(50);
    await pg.exec(`
      INSERT INTO governance_ceilings (axis, principal_kind, agent_user_id, scope_kind, limit_value) VALUES ('daily_write_count', 'agent', '${DEVBOX}', 'pod', 3);
    `);
    expect(await resolveDailyWriteCeiling({ db, agentUserId: DEVBOX })).toBe(3);
  });
});
