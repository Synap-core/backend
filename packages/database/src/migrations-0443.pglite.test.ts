/**
 * REAL-POSTGRES (PGlite) test for migrations 0442 + 0443 — a person owns what
 * an agent made; the agent is the actor:
 *   - 0442 adds `agent_user_id` to automations and playbooks, idempotently;
 *   - 0443 copies the agent into `agent_user_id` FIRST, then moves the owner
 *     to the person the approved create proposal was filed for (an agent
 *     subject falls through), else the one person its keys act for, else the
 *     person who created the agent; a humanless agent keeps its row;
 *   - a person's own row is untouched; a second run changes nothing;
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
const M0442 = read("0442_owner_actor_columns.sql");
const M0443 = read("0443_owner_actor_backfill.sql");
const BASELINE = read("0000_baseline_schema.sql");

const PERSON = "person-1";
const OTHER_PERSON = "person-2";
const ADMIN = "admin-1";
const AGENT = "agent-1"; // works for PERSON
const POD_AGENT = "agent-pod"; // pod-wide, installed by ADMIN
const ORPHAN = "agent-orphan"; // nobody installed it
const FOR_OTHER = "agent-for-other"; // installed by ADMIN, its key acts for OTHER_PERSON
const FOR_TWO = "agent-for-two"; // installed by ADMIN, keys for two people: ambiguous

const A_SUBJECT = "11111111-1111-4111-8111-111111111111"; // via an approved proposal
const A_POD = "22222222-2222-4222-8222-222222222222"; // proposal subject = the pod-wide agent
const A_CREATOR = "33333333-3333-4333-8333-333333333333"; // no proposal
const A_ORPHAN = "44444444-4444-4444-8444-444444444444";
const A_HUMAN = "55555555-5555-4555-8555-555555555555";
const P_AGENT = "66666666-6666-4666-8666-666666666666";
const A_LINKED = "77777777-7777-4777-8777-777777777777";
const A_TWO = "88888888-8888-4888-8888-888888888888";

type Row = { id: string; created_by: string; agent_user_id: string | null };

let pg: PGlite;
const rows = async (table: string): Promise<Row[]> =>
  (
    await pg.query<Row>(
      `SELECT id, created_by, agent_user_id FROM ${table} ORDER BY id`
    )
  ).rows;

beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stood before 0442 (only the columns the backfill reads).
  await pg.exec(`
    CREATE TABLE "users" (
      "id" text PRIMARY KEY,
      "user_type" text NOT NULL DEFAULT 'human',
      "created_by_user_id" text
    );
    CREATE TABLE "api_keys" ("id" text PRIMARY KEY, "user_id" text NOT NULL, "linked_user_id" text);
    CREATE TABLE "automations" ("id" uuid PRIMARY KEY, "created_by" text NOT NULL);
    CREATE TABLE "playbooks" ("id" uuid PRIMARY KEY, "created_by" text NOT NULL);
    CREATE TABLE "proposals" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "target_type" text NOT NULL,
      "target_id" text NOT NULL,
      "proposal_type" text NOT NULL,
      "status" text NOT NULL,
      "subject_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users (id, user_type, created_by_user_id) VALUES
      ('${PERSON}', 'human', NULL),
      ('${OTHER_PERSON}', 'human', NULL),
      ('${ADMIN}', 'human', NULL),
      ('${AGENT}', 'agent', '${PERSON}'),
      ('${POD_AGENT}', 'agent', '${ADMIN}'),
      ('${ORPHAN}', 'agent', NULL),
      ('${FOR_OTHER}', 'agent', '${ADMIN}'),
      ('${FOR_TWO}', 'agent', '${ADMIN}');
    INSERT INTO api_keys (id, user_id, linked_user_id) VALUES
      ('k1', '${FOR_OTHER}', '${OTHER_PERSON}'),
      ('k2', '${FOR_OTHER}', '${OTHER_PERSON}'),
      ('k3', '${FOR_TWO}', '${PERSON}'),
      ('k4', '${FOR_TWO}', '${OTHER_PERSON}');
    INSERT INTO automations (id, created_by) VALUES
      ('${A_SUBJECT}', '${AGENT}'),
      ('${A_POD}', '${POD_AGENT}'),
      ('${A_CREATOR}', '${AGENT}'),
      ('${A_ORPHAN}', '${ORPHAN}'),
      ('${A_HUMAN}', '${PERSON}'),
      ('${A_LINKED}', '${FOR_OTHER}'),
      ('${A_TWO}', '${FOR_TWO}');
    INSERT INTO playbooks (id, created_by) VALUES ('${P_AGENT}', '${AGENT}');
    -- Filed by AGENT for OTHER_PERSON (a delegated key of theirs): the subject wins.
    INSERT INTO proposals (target_type, target_id, proposal_type, status, subject_user_id)
      VALUES ('automation', '${A_SUBJECT}', 'create', 'approved', '${OTHER_PERSON}');
    -- A pod-wide agent's own proposal: its subject IS the agent → its person.
    INSERT INTO proposals (target_type, target_id, proposal_type, status, subject_user_id)
      VALUES ('automation', '${A_POD}', 'create', 'approved', '${POD_AGENT}');
    -- A rejected proposal names nobody.
    INSERT INTO proposals (target_type, target_id, proposal_type, status, subject_user_id)
      VALUES ('automation', '${A_CREATOR}', 'create', 'rejected', '${OTHER_PERSON}');
  `);
  await pg.exec(M0442);
  await pg.exec(M0442);
  await pg.exec(M0443);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0443 — the person owns it, the agent is the actor", () => {
  it("moves each agent-owned automation to its person and keeps the agent as actor", async () => {
    expect(await rows("automations")).toEqual([
      { id: A_SUBJECT, created_by: OTHER_PERSON, agent_user_id: AGENT },
      { id: A_POD, created_by: ADMIN, agent_user_id: POD_AGENT },
      { id: A_CREATOR, created_by: PERSON, agent_user_id: AGENT },
      // Nobody stands behind it: it stays the agent's, governed as the agent.
      { id: A_ORPHAN, created_by: ORPHAN, agent_user_id: ORPHAN },
      // A person's own automation: untouched, no actor.
      { id: A_HUMAN, created_by: PERSON, agent_user_id: null },
      // The one person its keys act for, before its installer.
      { id: A_LINKED, created_by: OTHER_PERSON, agent_user_id: FOR_OTHER },
      // Keys for two people: no single person, so its installer.
      { id: A_TWO, created_by: ADMIN, agent_user_id: FOR_TWO },
    ]);
  });

  it("moves an agent-owned playbook the same way", async () => {
    expect(await rows("playbooks")).toEqual([
      { id: P_AGENT, created_by: PERSON, agent_user_id: AGENT },
    ]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = [await rows("automations"), await rows("playbooks")];
    await pg.exec(M0443);
    expect([await rows("automations"), await rows("playbooks")]).toEqual(
      before
    );
  });

  it("the baseline carries the columns and the boot check names them", () => {
    expect(BASELINE).toMatch(
      /CREATE TABLE IF NOT EXISTS "automations" \([\s\S]*?"agent_user_id"\s+text\s+REFERENCES "users"\("id"\) ON DELETE SET NULL/
    );
    expect(BASELINE).toMatch(
      /CREATE TABLE IF NOT EXISTS "playbooks" \([\s\S]*?"agent_user_id"\s+text\s+REFERENCES "users"\("id"\) ON DELETE SET NULL/
    );
    for (const table of ["automations", "playbooks"]) {
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({ table, column: "agent_user_id" })
      );
    }
  });
});
