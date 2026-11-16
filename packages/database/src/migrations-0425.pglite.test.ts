/**
 * REAL-POSTGRES (PGlite) test for migration 0425 — one link per relation for a
 * playbook's automations, and the drop of `playbooks.required_intents`
 * (Process wave plan 0adf8352, W2):
 *   - a `flow_automation_id` naming a cron automation becomes its join row with
 *     role `schedule`, one naming a manual (canvas) automation role `flow`;
 *   - a row that already composes that automation WITHOUT a role takes the
 *     role; one WITH a role keeps it;
 *   - a dangling `flow_automation_id` (its automation is gone) is not copied;
 *   - every legacy `automation --member_of--> playbook` link lands in the join
 *     table (once), a malformed id is skipped;
 *   - `required_intents` is gone; re-running changes nothing;
 *   - the baseline no longer adds `required_intents`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0425 = read("0425_process_one_link.sql");
const BASELINE = read("0000_baseline_schema.sql");

const PB_CRON = "11111111-1111-4111-8111-111111111111";
const PB_FLOW = "22222222-2222-4222-8222-222222222222";
const PB_DANGLING = "33333333-3333-4333-8333-333333333333";
const PB_MEMBER = "44444444-4444-4444-8444-444444444444";
const PB_ROLED = "55555555-5555-4555-8555-555555555555";
const A_CRON = "a1111111-1111-4111-8111-111111111111";
const A_MANUAL = "a2222222-2222-4222-8222-222222222222";
const A_GONE = "a3333333-3333-4333-8333-333333333333";
const A_MEMBER = "a4444444-4444-4444-8444-444444444444";
const A_ROLED = "a5555555-5555-4555-8555-555555555555";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stand before 0425 (the columns it reads and writes).
  await pg.exec(`
    CREATE TABLE "automations" ("id" uuid PRIMARY KEY, "trigger_type" text NOT NULL);
    CREATE TABLE "playbooks" (
      "id" uuid PRIMARY KEY,
      "flow_automation_id" uuid,
      "required_intents" jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "links" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "from_type" text NOT NULL, "from_id" text NOT NULL,
      "to_type" text NOT NULL, "to_id" text NOT NULL,
      "link_type" text NOT NULL
    );
    CREATE TABLE "playbook_automations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "playbook_id" uuid NOT NULL,
      "automation_id" uuid NOT NULL,
      "role" text,
      "sort_order" integer,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "idx_playbook_automations_unique"
      ON "playbook_automations" ("playbook_id", "automation_id");

    INSERT INTO "automations" VALUES
      ('${A_CRON}', 'cron'), ('${A_MANUAL}', 'manual'),
      ('${A_MEMBER}', 'event'), ('${A_ROLED}', 'cron');
    INSERT INTO "playbooks" ("id", "flow_automation_id") VALUES
      ('${PB_CRON}', '${A_CRON}'),
      ('${PB_FLOW}', '${A_MANUAL}'),
      ('${PB_DANGLING}', '${A_GONE}'),
      ('${PB_MEMBER}', NULL),
      ('${PB_ROLED}', '${A_ROLED}');
    -- The cron one was already composed by a dual write, with no role.
    INSERT INTO "playbook_automations" ("playbook_id", "automation_id") VALUES
      ('${PB_CRON}', '${A_CRON}');
    -- This one already carries a role: it keeps it.
    INSERT INTO "playbook_automations" ("playbook_id", "automation_id", "role") VALUES
      ('${PB_ROLED}', '${A_ROLED}', 'activator');
    INSERT INTO "links" ("from_type", "from_id", "to_type", "to_id", "link_type") VALUES
      ('automation', '${A_MEMBER}', 'playbook', '${PB_MEMBER}', 'member_of'),
      ('automation', 'not-a-uuid', 'playbook', '${PB_MEMBER}', 'member_of'),
      ('automation', '${A_MEMBER}', 'capability', '${PB_MEMBER}', 'member_of');
  `);
  await pg.exec(M0425);
});
afterAll(async () => {
  await pg.close();
});

const rows = async () =>
  (
    await pg.query<{
      playbook_id: string;
      automation_id: string;
      role: string | null;
    }>(
      `SELECT playbook_id, automation_id, role FROM playbook_automations
        ORDER BY playbook_id, automation_id`
    )
  ).rows;

describe("migration 0425 — one link per relation", () => {
  it("copies each flow_automation_id as schedule (cron) or flow (canvas), fills a NULL role, keeps a set one", async () => {
    expect(await rows()).toEqual([
      { playbook_id: PB_CRON, automation_id: A_CRON, role: "schedule" },
      { playbook_id: PB_FLOW, automation_id: A_MANUAL, role: "flow" },
      { playbook_id: PB_MEMBER, automation_id: A_MEMBER, role: null },
      { playbook_id: PB_ROLED, automation_id: A_ROLED, role: "activator" },
    ]);
  });

  it("never copies a dangling flow_automation_id", async () => {
    const all = await rows();
    expect(all.some((r) => r.playbook_id === PB_DANGLING)).toBe(false);
  });

  it("drops required_intents", async () => {
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'playbooks'`
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain(
      "required_intents"
    );
  });

  it("re-running changes nothing", async () => {
    const before = await rows();
    await pg.exec(M0425);
    expect(await rows()).toEqual(before);
  });

  it("the baseline no longer adds required_intents", () => {
    expect(BASELINE).not.toMatch(/ADD COLUMN IF NOT EXISTS "required_intents"/);
  });
});
