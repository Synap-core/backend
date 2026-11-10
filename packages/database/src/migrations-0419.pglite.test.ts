/**
 * REAL-POSTGRES (PGlite) test for migration 0419 — the ONE `tools` field of a
 * playbook (plan 08e4fba7, decisions 3 and 4):
 *   - `required_intents`, the `grants` links (a tool or skill row by its NAME,
 *     anything else by id), `stages[].grants` and the space's `taskIntents`
 *     fold into `playbooks.tools`, each entry once, in that order;
 *   - a stage's `grants` becomes its `tools` and the key is gone;
 *   - an existing SHORT run (is-agent, at most 2 stages, no gate) keeps the
 *     write tools it had (the 13 of the old core past the 6-read floor), on
 *     the playbook and on each stage that now carries a list; a long one, a
 *     generate one and an external one do not;
 *   - re-running changes nothing; the baseline and the boot check name it.
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
const M0419 = read("0419_playbook_tools.sql");
const BASELINE = read("0000_baseline_schema.sql");

const WS = "11111111-1111-4111-8111-111111111111";
const SHORT = "22222222-2222-4222-8222-222222222222";
const LONG = "33333333-3333-4333-8333-333333333333";
const GEN = "44444444-4444-4444-8444-444444444444";
const GATED = "55555555-5555-4555-8555-555555555555";
const TOOL = "66666666-6666-4666-8666-666666666666";
const SKILL = "77777777-7777-4777-8777-777777777777";

const WRITES = [
  "list_profiles",
  "get_profile",
  "create_entity",
  "update_entity",
  "update_entities",
  "create_document",
  "update_document",
  "create_relation",
  "propose_entity_graph",
  "resolve_identity",
  "attach_facet",
  "update_facet",
  "detach_facet",
];

const stage = (key: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ key, name: key, category: "started", ...extra });

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stood before 0419 (the columns the fold reads).
  await pg.exec(`
    CREATE TABLE "workspaces" ("id" uuid PRIMARY KEY, "settings" jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "tools" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
    CREATE TABLE "skills" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
    CREATE TABLE "links" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "from_type" text NOT NULL, "from_id" text NOT NULL,
      "to_type" text NOT NULL, "to_id" text NOT NULL,
      "link_type" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "playbooks" (
      "id" uuid PRIMARY KEY,
      "workspace_id" uuid,
      "executor" text NOT NULL DEFAULT 'is-agent',
      "stages" jsonb NOT NULL DEFAULT '[]',
      "required_intents" jsonb NOT NULL DEFAULT '[]'
    );
    INSERT INTO "workspaces" VALUES ('${WS}', '{"taskIntents":["search_external","send_message"]}');
    INSERT INTO "tools" VALUES ('${TOOL}', 'apify_run_actor');
    INSERT INTO "skills" VALUES ('${SKILL}', 'source-triage');
    INSERT INTO "playbooks" ("id", "workspace_id", "executor", "stages", "required_intents") VALUES
      ('${SHORT}', '${WS}', 'is-agent',
       '[${stage("frame", { grants: [{ kind: "skill", id: "jev-routing-policy" }] })}, ${stage("ask")}]',
       '["enrich_entity","search_external"]'),
      ('${LONG}', NULL, 'is-agent',
       '[${stage("a")}, ${stage("b", { grants: [{ kind: "skill", id: "datagouv_get_dataset" }] })}, ${stage("c")}]',
       '["list_records"]'),
      ('${GEN}', NULL, 'generate', '[]', '[]'),
      ('${GATED}', NULL, 'is-agent', '[${stage("review", { gate: { kind: "human" } })}]', '[]');
    INSERT INTO "links" ("from_type", "from_id", "to_type", "to_id", "link_type", "created_at") VALUES
      ('playbook', '${SHORT}', 'tool', '${TOOL}', 'grants', now() - interval '2 minutes'),
      ('playbook', '${SHORT}', 'skill', '${SKILL}', 'grants', now() - interval '1 minute'),
      ('playbook', '${SHORT}', 'capability', 'cap-bundle-1', 'grants', now()),
      ('playbook', '${SHORT}', 'tool', '${TOOL}', 'uses', now());
  `);
  await pg.exec(M0419);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

async function row(id: string) {
  const { rows } = await pg.query<{
    tools: string[];
    stages: Array<Record<string, unknown>>;
  }>(`SELECT tools, stages FROM playbooks WHERE id = $1`, [id]);
  return rows[0]!;
}

describe("migration 0419 — one tools field", () => {
  it("folds intents, grants links (by name), stage grants and the space's taskIntents, each once, in order; a short run keeps its writes", async () => {
    const { tools } = await row(SHORT);
    expect(tools).toEqual([
      "enrich_entity",
      "search_external",
      "apify_run_actor",
      "source-triage",
      "cap-bundle-1",
      "jev-routing-policy",
      "send_message",
      ...WRITES,
    ]);
  });

  it("a stage's grants become its tools (with a short run's writes) and the key is gone", async () => {
    const { stages } = await row(SHORT);
    expect(stages[0]).not.toHaveProperty("grants");
    expect(stages[0]!.tools).toEqual(["jev-routing-policy", ...WRITES]);
    expect(stages[1]).not.toHaveProperty("tools");
    // A stage list stays a subset of its playbook's.
    const { tools } = await row(SHORT);
    for (const t of stages[0]!.tools as string[]) expect(tools).toContain(t);
  });

  it("a long run, a gated run and a generate run get no write tools folded in", async () => {
    const long = await row(LONG);
    expect(long.tools).toEqual(["list_records", "datagouv_get_dataset"]);
    expect(long.stages[1]!.tools).toEqual(["datagouv_get_dataset"]);
    expect((await row(GATED)).tools).toEqual([]);
    expect((await row(GEN)).tools).toEqual([]);
  });

  it("re-running changes nothing", async () => {
    const before = await Promise.all([SHORT, LONG, GEN, GATED].map(row));
    await pg.exec(M0419);
    const after = await Promise.all([SHORT, LONG, GEN, GATED].map(row));
    expect(after).toEqual(before);
  });

  it("tools is never NULL; the baseline carries the column and the boot check names it", async () => {
    await expect(
      pg.query(
        `INSERT INTO playbooks (id, tools) VALUES (gen_random_uuid(), NULL)`
      )
    ).rejects.toThrow();
    const line =
      'ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "tools" jsonb NOT NULL DEFAULT \'[]\'::jsonb;';
    expect(M0419).toContain(line);
    expect(BASELINE).toContain(line);
    expect(
      REQUIRED_COLUMNS.some(
        (c) => c.table === "playbooks" && c.column === "tools"
      )
    ).toBe(true);
  });
});
