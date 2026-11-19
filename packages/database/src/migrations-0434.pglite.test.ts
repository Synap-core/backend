/**
 * REAL-POSTGRES (PGlite) test for migration 0434 — one approval store
 * (founder decisions D2 and D3, 19 Nov 2026, document b387ca45): a capability
 * grant's `exec_mode` becomes an approval row, then the column is retired.
 *
 * It proves, through the REAL resolver (`resolveGovernanceRule`, the read the
 * capability gate makes):
 *   - an auto grant keeps running for exactly the agent × action × space it
 *     covered, and for nobody else (the migration preserves auto);
 *   - a propose grant makes no row (it behaved like no grant), a dry-run grant
 *     makes an "ask first" row, a capped grant and an auto grant a "Never"
 *     could cover make none, a secret / revoked / expired grant makes none;
 *   - the file runs twice with one set of rows, and drops the column and type;
 *   - after it, a stored "ask first" on the same reach as an auto row wins
 *     (the stricter verdict takes a tool run's tie, whatever the age), and a
 *     row naming the TOOL covers each of its actions below a row naming one;
 *   - the baseline and the boot coherence list no longer carry the column;
 *   - the read-only dry run (`scripts/0434-dry-run.sql`, the report run on a
 *     real pod before the migration) classifies every grant and names
 *     exactly the rows the migration then writes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";
import { resolveGovernanceRule } from "./utils/resolve-agent-governance-decision.js";
import { GRANT_EXEC_MODE_CREATED_BY_PREFIX } from "./utils/governance-rule-provenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0434 = read("0434_grant_exec_mode_to_approval_rows.sql");
const BASELINE = read("0000_baseline_schema.sql");
const DRY_RUN = readFileSync(
  resolve(HERE, "../scripts/0434-dry-run.sql"),
  "utf8"
);

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSON = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WS1 = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const T_MAIL = "30000000-0000-4000-8000-000000000001";
const S_CRM = "30000000-0000-4000-8000-000000000002";
const T_PROPOSE = "30000000-0000-4000-8000-000000000003";
const T_DRYRUN = "30000000-0000-4000-8000-000000000004";
const T_CAPPED = "30000000-0000-4000-8000-000000000005";
const T_NEVER = "30000000-0000-4000-8000-000000000006";
const TOOL_BOX = "40000000-0000-4000-8000-000000000001"; // a capability container

const G = {
  autoAgentSpace: "50000000-0000-4000-8000-000000000001",
  autoAnyoneSpace: "50000000-0000-4000-8000-000000000002",
  propose: "50000000-0000-4000-8000-000000000003",
  dryRun: "50000000-0000-4000-8000-000000000004",
  capped: "50000000-0000-4000-8000-000000000005",
  coveredByNever: "50000000-0000-4000-8000-000000000006",
  secret: "50000000-0000-4000-8000-000000000007",
  revoked: "50000000-0000-4000-8000-000000000008",
  expired: "50000000-0000-4000-8000-000000000009",
  // The install's seeded propose grant on the same action and space as the
  // session pre-approval: today the two tie in the grant lookup.
  installBeside: "50000000-0000-4000-8000-00000000000a",
};

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
/** The dry run's rows, read BEFORE the migration ran. */
let dryRun: Array<{ section: string; item: string; n: number }> = [];

beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stood before 0434 (the columns the migration and the
  // resolver read).
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      user_type text NOT NULL DEFAULT 'human',
      agent_type text
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
      target_subject_id uuid,
      target_subject_version integer,
      principal_owner_id text,
      verdict governance_verdict NOT NULL,
      source_proposal_id uuid,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz,
      revoked_reason text
    );
    CREATE TABLE tools (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE skills (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE capabilities (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE channel_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id uuid NOT NULL,
      member_id text NOT NULL,
      member_kind text NOT NULL,
      can_act boolean NOT NULL DEFAULT false
    );
    INSERT INTO channel_members (channel_id, member_id, member_kind, can_act) VALUES
      ('60000000-0000-4000-8000-000000000001', '${AGENT_A}', 'ai_agent', false),
      ('60000000-0000-4000-8000-000000000001', '${PERSON}', 'human', false),
      ('60000000-0000-4000-8000-000000000002', '${AGENT_B}', 'ai_agent', true);
    CREATE TABLE links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      from_type text NOT NULL,
      from_id text NOT NULL,
      to_type text NOT NULL,
      to_id text NOT NULL,
      link_type text NOT NULL
    );
    CREATE TYPE grantable_type AS ENUM ('secret','tool','skill','command');
    CREATE TYPE grant_exec_mode AS ENUM ('auto','propose','dry-run');
    CREATE TABLE vault_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grantable_type grantable_type NOT NULL,
      grantable_id text NOT NULL,
      exec_mode grant_exec_mode NOT NULL DEFAULT 'auto',
      proposal_id uuid,
      granted_to text,
      workspace_id uuid,
      scope text NOT NULL DEFAULT 'session',
      expires_at timestamptz,
      max_uses integer,
      use_count integer NOT NULL DEFAULT 0,
      revoked_at timestamptz,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO users (id, user_type) VALUES
      ('${AGENT_A}', 'agent'), ('${AGENT_B}', 'agent'), ('${PERSON}', 'human');
    INSERT INTO tools (id, name) VALUES
      ('${T_MAIL}', 'mail_send'), ('${T_PROPOSE}', 'crm_write'),
      ('${T_DRYRUN}', 'post_publish'), ('${T_CAPPED}', 'pay_invoice'),
      ('${T_NEVER}', 'danger_tool');
    INSERT INTO skills (id, name) VALUES ('${S_CRM}', 'crm_lookup');
    -- crm_write is an action of the tool TOOL_BOX.
    INSERT INTO links (from_type, from_id, to_type, to_id, link_type) VALUES
      ('tool', '${T_PROPOSE}', 'capability', '${TOOL_BOX}', 'member_of');

    -- A person's "Never" on danger_tool, for everyone, pod-wide.
    INSERT INTO governance_rules (principal_kind, scope_kind, target_kind,
      target_pattern, verdict, created_by)
    VALUES ('any', 'pod', 'capability', 'danger_tool', 'deny', 'user:${PERSON}');

    INSERT INTO vault_grants (id, grantable_type, grantable_id, exec_mode,
      granted_to, workspace_id, max_uses, revoked_at, expires_at, created_by)
    VALUES
      -- a session pre-approval: agent A may run mail_send in WS1
      ('${G.autoAgentSpace}', 'tool', '${T_MAIL}', 'auto', '${AGENT_A}', '${WS1}', NULL, NULL, NULL, '${PERSON}'),
      -- anyone in WS1 may run crm_lookup
      ('${G.autoAnyoneSpace}', 'skill', '${S_CRM}', 'auto', NULL, '${WS1}', NULL, NULL, NULL, '${PERSON}'),
      -- the install's seeded grant: propose
      ('${G.propose}', 'tool', '${T_PROPOSE}', 'propose', NULL, '${WS1}', NULL, NULL, NULL, '${PERSON}'),
      -- a dry-run grant, pod-wide, for agent A
      ('${G.dryRun}', 'tool', '${T_DRYRUN}', 'dry-run', '${AGENT_A}', NULL, NULL, NULL, NULL, '${PERSON}'),
      -- a once grant: an approval row has no use count
      ('${G.capped}', 'tool', '${T_CAPPED}', 'auto', '${AGENT_A}', '${WS1}', 1, NULL, NULL, '${PERSON}'),
      -- an auto grant a Never covers
      ('${G.coveredByNever}', 'tool', '${T_NEVER}', 'auto', '${AGENT_A}', '${WS1}', NULL, NULL, NULL, '${PERSON}'),
      -- a secret read: not a tool run
      ('${G.secret}', 'secret', '${T_MAIL}', 'auto', '${AGENT_A}', '${WS1}', NULL, NULL, NULL, '${PERSON}'),
      -- revoked and expired grants decide nothing
      ('${G.revoked}', 'tool', '${T_MAIL}', 'auto', '${AGENT_B}', '${WS1}', NULL, now(), NULL, '${PERSON}'),
      ('${G.expired}', 'tool', '${T_MAIL}', 'auto', '${AGENT_B}', '${WS2}', NULL, NULL, now() - interval '1 day', '${PERSON}'),
      ('${G.installBeside}', 'tool', '${T_MAIL}', 'propose', NULL, '${WS1}', NULL, NULL, NULL, '${PERSON}');
  `);
  await pg.exec("BEGIN TRANSACTION READ ONLY");
  dryRun = (
    await pg.query<{ section: string; item: string; n: number }>(DRY_RUN)
  ).rows;
  await pg.exec("ROLLBACK");
  await pg.exec(M0434);
  await pg.exec(M0434);
  db = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

async function verdict(
  agentUserId: string,
  workspaceId: string,
  capabilityId: string,
  capabilityVerbName: string,
  capabilityKind: "tool" | "skill" = "tool"
) {
  const match = await resolveGovernanceRule({
    db,
    agentUserId,
    workspaceId,
    subjectType: "capability",
    action: "run",
    capabilityId,
    capabilityVerbName,
    capabilityKind,
  });
  return match?.verdict;
}

describe("migration 0434 — a grant's exec_mode becomes an approval row", () => {
  it("writes one row per auto or dry-run grant it may carry over, once", async () => {
    const { rows } = await pg.query<{
      created_by: string;
      principal_kind: string;
      agent_user_id: string | null;
      scope_kind: string;
      workspace_id: string | null;
      target_kind: string;
      target_pattern: string;
      verdict: string;
      source_proposal_id: string | null;
    }>(
      `SELECT created_by, principal_kind, agent_user_id, scope_kind,
              workspace_id, target_kind, target_pattern, verdict,
              source_proposal_id
         FROM governance_rules
        WHERE created_by LIKE $1 ORDER BY target_pattern`,
      [`${GRANT_EXEC_MODE_CREATED_BY_PREFIX}%`]
    );
    expect(rows).toEqual([
      {
        created_by: `${GRANT_EXEC_MODE_CREATED_BY_PREFIX}${G.autoAgentSpace}`,
        principal_kind: "agent",
        agent_user_id: AGENT_A,
        scope_kind: "workspace",
        workspace_id: WS1,
        target_kind: "capability",
        target_pattern: T_MAIL,
        verdict: "auto",
        source_proposal_id: null,
      },
      {
        created_by: `${GRANT_EXEC_MODE_CREATED_BY_PREFIX}${G.autoAnyoneSpace}`,
        principal_kind: "any",
        agent_user_id: null,
        scope_kind: "workspace",
        workspace_id: WS1,
        target_kind: "capability",
        target_pattern: S_CRM,
        verdict: "auto",
        source_proposal_id: null,
      },
      {
        created_by: `${GRANT_EXEC_MODE_CREATED_BY_PREFIX}${G.dryRun}`,
        principal_kind: "agent",
        agent_user_id: AGENT_A,
        scope_kind: "pod",
        workspace_id: null,
        target_kind: "capability",
        target_pattern: T_DRYRUN,
        verdict: "propose",
        source_proposal_id: null,
      },
    ]);
  });

  it("drops the column and its type", async () => {
    const col = await pg.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vault_grants' AND column_name = 'exec_mode'`
    );
    expect(col.rows).toHaveLength(0);
    const type = await pg.query(
      `SELECT 1 FROM pg_type WHERE typname = 'grant_exec_mode'`
    );
    expect(type.rows).toHaveLength(0);
  });

  it("preserves auto: the grant's agent runs in the grant's space, and nobody else gains", async () => {
    // Also the ambiguous pair's answer: the install's propose grant beside it
    // made no row, so the session pre-approval decides.
    expect(await verdict(AGENT_A, WS1, T_MAIL, "mail_send")).toBe("auto");
    // Another agent, or the same agent in another space, gains nothing.
    expect(await verdict(AGENT_B, WS1, T_MAIL, "mail_send")).toBeUndefined();
    expect(await verdict(AGENT_A, WS2, T_MAIL, "mail_send")).toBeUndefined();
    // A grant naming no agent: every agent in its space.
    expect(await verdict(AGENT_B, WS1, S_CRM, "crm_lookup", "skill")).toBe(
      "auto"
    );
    expect(
      await verdict(AGENT_B, WS2, S_CRM, "crm_lookup", "skill")
    ).toBeUndefined();
  });

  it("a propose grant makes no row; a dry-run grant asks; a capped grant and a covered one make none", async () => {
    expect(await verdict(AGENT_A, WS1, T_PROPOSE, "crm_write")).toBeUndefined();
    expect(await verdict(AGENT_A, WS1, T_DRYRUN, "post_publish")).toBe(
      "propose"
    );
    expect(
      await verdict(AGENT_A, WS1, T_CAPPED, "pay_invoice")
    ).toBeUndefined();
    // The Never still refuses: no more specific auto row was made to outrank it.
    expect(await verdict(AGENT_A, WS1, T_NEVER, "danger_tool")).toBe("deny");
  });
});

describe("after 0434 — the approval row is the one answer", () => {
  it("an 'ask first' on the same reach as an auto row wins the tie, older or newer", async () => {
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, agent_user_id, scope_kind,
        workspace_id, target_kind, target_pattern, verdict, created_by, created_at)
      VALUES ('agent', '${AGENT_A}', 'workspace', '${WS1}', 'capability',
        '${T_MAIL}', 'propose', 'user:${PERSON}', now() - interval '1 day');
    `);
    expect(await verdict(AGENT_A, WS1, T_MAIL, "mail_send")).toBe("propose");
  });

  it("a row naming the tool covers its action; a row naming the action outranks it", async () => {
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, scope_kind, target_kind,
        target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'capability', '${TOOL_BOX}', 'auto', 'user:${PERSON}');
    `);
    // Everyone × this tool × pod → auto covers crm_write.
    expect(await verdict(AGENT_B, WS2, T_PROPOSE, "crm_write")).toBe("auto");
    // Without the kind, the resolver does not look the tool up: no match.
    expect(
      (
        await resolveGovernanceRule({
          db,
          agentUserId: AGENT_B,
          workspaceId: WS2,
          subjectType: "capability",
          action: "run",
          capabilityId: T_PROPOSE,
          capabilityVerbName: "crm_write",
        })
      )?.verdict
    ).toBeUndefined();
    // A row naming the action for everyone outranks the tool row.
    await pg.exec(`
      INSERT INTO governance_rules (principal_kind, scope_kind, target_kind,
        target_pattern, verdict, created_by)
      VALUES ('any', 'pod', 'capability', 'crm_write', 'propose', 'user:${PERSON}');
    `);
    expect(await verdict(AGENT_B, WS2, T_PROPOSE, "crm_write")).toBe("propose");
  });

  it("the dry run classifies every grant and names exactly the rows the migration wrote", async () => {
    // Sorted here, by code unit: the SQL's ORDER BY follows the database
    // collation, which a real pod may set differently.
    const bySection = (section: string) =>
      dryRun
        .filter((r) => r.section === section)
        .map((r) => [r.item, r.n] as const)
        .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    expect(bySection("1-grants")).toEqual([
      ["secret auto live", 1],
      ["skill auto live", 1],
      ["tool auto live", 3],
      ["tool auto not live", 2],
      ["tool dry-run live", 1],
      ["tool propose live", 2],
    ]);
    expect(bySection("2-outcome")).toEqual([
      ["no row: a propose grant behaved as no grant (tool)", 2],
      ["none: a Never could cover it (tool)", 1],
      ["none: capped in uses (tool)", 1],
      ["row: ask first (was dry-run) (tool)", 1],
      ["row: auto (skill)", 1],
      ["row: auto (tool)", 1],
    ]);
    const predicted = dryRun
      .filter((r) => r.section === "3-row")
      .map((r) => r.item.split(" ")[0])
      .sort();
    const { rows: written } = await pg.query<{ id: string }>(
      `SELECT substr(created_by, length($1) + 1) AS id FROM governance_rules
        WHERE created_by LIKE $1 || '%' ORDER BY 1`,
      [GRANT_EXEC_MODE_CREATED_BY_PREFIX]
    );
    expect(predicted).toEqual(written.map((r) => r.id));
    expect(bySection("4-change-never").map(([i]) => i.split(" ")[0])).toEqual([
      G.coveredByNever,
    ]);
    expect(bySection("4-change-capped").map(([i]) => i.split(" ")[0])).toEqual([
      G.capped,
    ]);
    expect(bySection("4-change-dry-run").map(([i]) => i.split(" ")[0])).toEqual(
      [G.dryRun]
    );
    // The session pre-approval and the install's grant disagree; after 0434
    // the auto one decides (asserted through the resolver below).
    expect(bySection("4-change-ambiguous")).toEqual([
      [
        `${G.autoAgentSpace} (auto) and ${G.installBeside} (propose) on mail_send agent=${AGENT_A} space=${WS1} -> after 0434: auto (runs)`,
        1,
      ],
    ]);
    // Tighten-only, counted: no auto row existed before; one agent membership
    // may not act (a person's membership, and an agent that may act, are not counted).
    expect(bySection("4-change-channel-rows")).toEqual([
      [
        "active auto capability rows that now meet a stricter channel (tighten-only)",
        0,
      ],
    ]);
    expect(bySection("4-change-channel-members")).toEqual([
      [
        "agent channel memberships with can_act = false, in 1 channel(s) (tighten-only)",
        1,
      ],
    ]);
    for (const none of [
      "4-change-ask-first",
      "4-change-tie",
      "4-change-tool-row",
    ]) {
      expect(bySection(none), none).toEqual([]);
    }
  });

  it("the baseline and the boot coherence list no longer carry the column", () => {
    expect(BASELINE).not.toContain("exec_mode");
    expect(BASELINE).not.toContain("grant_exec_mode");
    expect(REQUIRED_COLUMNS).not.toContainEqual(
      expect.objectContaining({ table: "vault_grants", column: "exec_mode" })
    );
  });
});
