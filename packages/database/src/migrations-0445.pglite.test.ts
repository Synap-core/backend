/**
 * REAL-POSTGRES (PGlite) test for migration 0445 — a person owns the tools,
 * capabilities, skills, artifacts and workspaces an agent made; the agent is
 * the actor:
 *   - the actor is copied FIRST, then the owner moves to the approved create
 *     proposal's subject, else the one person the agent's keys act for, else
 *     the person who created the agent; a humanless agent keeps its rows;
 *   - a moved workspace keeps its agent as an admin member and gives its
 *     person the owner membership;
 *   - a person's own rows are untouched; a second run changes nothing;
 *   - the baseline carries the columns; the boot coherence list names them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0445 = read("0445_owner_actor_more_tables.sql");
const BASELINE = read("0000_baseline_schema.sql");

const PERSON = "person-1";
const OTHER_PERSON = "person-2";
const ADMIN = "admin-1";
const AGENT = "agent-1"; // created by PERSON
const POD_AGENT = "agent-pod"; // created by ADMIN
const ORPHAN = "agent-orphan"; // nobody created it
const FOR_OTHER = "agent-for-other"; // created by ADMIN, its key acts for OTHER_PERSON

const T_SUBJECT = "11111111-1111-4111-8111-111111111111";
const T_HUMAN = "22222222-2222-4222-8222-222222222222";
const C_CREATOR = "33333333-3333-4333-8333-333333333333";
const C_LINKED = "44444444-4444-4444-8444-444444444444";
const S_ORPHAN = "55555555-5555-4555-8555-555555555555";
const S_AGENT = "66666666-6666-4666-8666-666666666666";
const A_AGENT = "77777777-7777-4777-8777-777777777777";
const A_ACTOR_KEPT = "88888888-8888-4888-8888-888888888888";
const W_AGENT = "99999999-9999-4999-8999-999999999991";
const W_POD = "99999999-9999-4999-8999-999999999992";
const W_ORPHAN = "99999999-9999-4999-8999-999999999993";

let pg: PGlite;
const q = async <T>(sql: string): Promise<T[]> =>
  (await pg.query<T>(sql)).rows;

const snapshot = async () => ({
  tools: await q(
    `SELECT id, created_by, agent_user_id FROM tools ORDER BY id`
  ),
  capabilities: await q(
    `SELECT id, created_by, agent_user_id FROM capabilities ORDER BY id`
  ),
  skills: await q(
    `SELECT id, user_id, agent_user_id FROM skills ORDER BY id`
  ),
  artifacts: await q(
    `SELECT id, user_id, actor_id, origin_kind FROM artifacts ORDER BY id`
  ),
  workspaces: await q(`SELECT id, owner_id FROM workspaces ORDER BY id`),
  members: await q(
    `SELECT workspace_id, user_id, role FROM workspace_members ORDER BY workspace_id, user_id`
  ),
});

beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stood before 0445 (only the columns it reads).
  await pg.exec(`
    CREATE TABLE "users" (
      "id" text PRIMARY KEY,
      "user_type" text NOT NULL DEFAULT 'human',
      "created_by_user_id" text
    );
    CREATE TABLE "api_keys" ("id" text PRIMARY KEY, "user_id" text NOT NULL, "linked_user_id" text);
    CREATE TABLE "proposals" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "proposal_type" text NOT NULL,
      "status" text NOT NULL,
      "subject_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "tools" ("id" uuid PRIMARY KEY, "created_by" text NOT NULL);
    CREATE TABLE "capabilities" ("id" uuid PRIMARY KEY, "created_by" text NOT NULL);
    CREATE TABLE "skills" ("id" uuid PRIMARY KEY, "user_id" text NOT NULL);
    CREATE TABLE "artifacts" (
      "id" uuid PRIMARY KEY,
      "user_id" text NOT NULL,
      "origin_kind" text NOT NULL DEFAULT 'user',
      "actor_id" text
    );
    CREATE TABLE "workspaces" ("id" uuid PRIMARY KEY, "owner_id" text NOT NULL);
    CREATE TABLE "workspace_members" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "workspace_id" uuid,
      "user_id" text NOT NULL,
      "role" text NOT NULL
    );
    CREATE UNIQUE INDEX "workspace_members_workspace_user_unique"
      ON "workspace_members" ("workspace_id", "user_id");
    INSERT INTO users (id, user_type, created_by_user_id) VALUES
      ('${PERSON}', 'human', NULL),
      ('${OTHER_PERSON}', 'human', NULL),
      ('${ADMIN}', 'human', NULL),
      ('${AGENT}', 'agent', '${PERSON}'),
      ('${POD_AGENT}', 'agent', '${ADMIN}'),
      ('${ORPHAN}', 'agent', NULL),
      ('${FOR_OTHER}', 'agent', '${ADMIN}');
    INSERT INTO api_keys (id, user_id, linked_user_id) VALUES
      ('k1', '${FOR_OTHER}', '${OTHER_PERSON}');
    INSERT INTO tools (id, created_by) VALUES
      ('${T_SUBJECT}', '${AGENT}'),
      ('${T_HUMAN}', '${PERSON}');
    -- Filed by AGENT for OTHER_PERSON: the subject wins over the creator.
    INSERT INTO proposals (target_type, target_id, proposal_type, status, subject_user_id)
      VALUES ('tool', '${T_SUBJECT}', 'create', 'approved', '${OTHER_PERSON}');
    INSERT INTO capabilities (id, created_by) VALUES
      ('${C_CREATOR}', '${AGENT}'),
      ('${C_LINKED}', '${FOR_OTHER}');
    INSERT INTO skills (id, user_id) VALUES
      ('${S_ORPHAN}', '${ORPHAN}'),
      ('${S_AGENT}', '${AGENT}');
    INSERT INTO artifacts (id, user_id, origin_kind, actor_id) VALUES
      ('${A_AGENT}', '${AGENT}', 'user', NULL),
      ('${A_ACTOR_KEPT}', '${POD_AGENT}', 'agent', '${AGENT}');
    INSERT INTO workspaces (id, owner_id) VALUES
      ('${W_AGENT}', '${AGENT}'),
      ('${W_POD}', '${POD_AGENT}'),
      ('${W_ORPHAN}', '${ORPHAN}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${W_AGENT}', '${AGENT}', 'owner'),
      ('${W_AGENT}', '${PERSON}', 'admin'),
      ('${W_ORPHAN}', '${ORPHAN}', 'owner');
  `);
  await pg.exec(M0445);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0445 — the person owns it, the agent is the actor", () => {
  it("moves tools, capabilities and skills to their person and keeps the agent as actor", async () => {
    const s = await snapshot();
    expect(s.tools).toEqual([
      { id: T_SUBJECT, created_by: OTHER_PERSON, agent_user_id: AGENT },
      { id: T_HUMAN, created_by: PERSON, agent_user_id: null },
    ]);
    expect(s.capabilities).toEqual([
      { id: C_CREATOR, created_by: PERSON, agent_user_id: AGENT },
      // The one person its key acts for, before its creator.
      { id: C_LINKED, created_by: OTHER_PERSON, agent_user_id: FOR_OTHER },
    ]);
    expect(s.skills).toEqual([
      // Nobody stands behind it: it stays the agent's.
      { id: S_ORPHAN, user_id: ORPHAN, agent_user_id: ORPHAN },
      { id: S_AGENT, user_id: PERSON, agent_user_id: AGENT },
    ]);
  });

  it("moves artifacts and records the agent as their actor, keeping a recorded one", async () => {
    expect((await snapshot()).artifacts).toEqual([
      {
        id: A_AGENT,
        user_id: PERSON,
        actor_id: AGENT,
        origin_kind: "agent",
      },
      {
        id: A_ACTOR_KEPT,
        user_id: ADMIN,
        actor_id: AGENT,
        origin_kind: "agent",
      },
    ]);
  });

  it("moves a workspace to its person; the agent stays an admin member, never owner", async () => {
    const s = await snapshot();
    expect(s.workspaces).toEqual([
      { id: W_AGENT, owner_id: PERSON },
      { id: W_POD, owner_id: ADMIN },
      { id: W_ORPHAN, owner_id: ORPHAN },
    ]);
    expect(s.members).toEqual([
      { workspace_id: W_AGENT, user_id: AGENT, role: "admin" },
      { workspace_id: W_AGENT, user_id: PERSON, role: "owner" },
      { workspace_id: W_POD, user_id: ADMIN, role: "owner" },
      { workspace_id: W_POD, user_id: POD_AGENT, role: "admin" },
      { workspace_id: W_ORPHAN, user_id: ORPHAN, role: "owner" },
    ]);
  });

  it("is idempotent and leaves no helper behind", async () => {
    const before = await snapshot();
    await pg.exec(M0445);
    expect(await snapshot()).toEqual(before);
    expect(
      await q(
        `SELECT proname FROM pg_proc WHERE proname = '_0445_person_of_agent_row'`
      )
    ).toEqual([]);
  });

  it("the baseline carries the columns and the boot check names them", () => {
    for (const table of ["tools", "capabilities", "skills"]) {
      expect(BASELINE).toMatch(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS "${table}" \\([\\s\\S]*?"agent_user_id"\\s+text\\s+REFERENCES "users"\\("id"\\) ON DELETE SET NULL`
        )
      );
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({ table, column: "agent_user_id" })
      );
    }
  });
});
