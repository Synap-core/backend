/**
 * REAL-POSTGRES (PGlite) test for migration 0406 — a template's practices
 * attached to the agents already linked to it (lane D, D4):
 *   - on the tables at their 0390 + 0404 shape, every linked agent gets ONE `template`
 *     preset: label "From the <name> template", skill_slugs = the template's
 *     practices.skills;
 *   - an agent with no link, a computer, a person, and an agent that already
 *     has a `template` preset (the person's edit) get nothing;
 *   - run twice, it writes nothing the second time.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0406 = read("0406_agent_template_practices.sql");

// The two tables the migration reads and the one it writes, at their shape
// after 0390 and 0404 (the columns it touches, the constraints it relies on).
const PRE_0406 = `
CREATE TABLE users (
  id text PRIMARY KEY,
  user_type text NOT NULL DEFAULT 'human',
  agent_type text,
  agent_template_slug text
);
CREATE TABLE agent_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  harness text NOT NULL,
  practices jsonb NOT NULL DEFAULT '{"skills":[]}'
);
CREATE TABLE agent_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  workspace_id uuid,
  agent_type text NOT NULL,
  prompt_append text,
  extra_tool_ids jsonb NOT NULL DEFAULT '[]',
  disabled_tool_ids jsonb NOT NULL DEFAULT '[]',
  model_override text,
  preset_key text,
  preset_label text,
  provider_override text,
  skill_slugs jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_configs_user_workspace_agent_unique
    UNIQUE (user_id, workspace_id, agent_type),
  CONSTRAINT agent_configs_preset_pod_wide
    CHECK (preset_key IS NULL OR workspace_id IS NULL)
);
CREATE UNIQUE INDEX agent_configs_user_preset_unique
  ON agent_configs (user_id, preset_key) WHERE preset_key IS NOT NULL;
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(PRE_0406);
  await pg.exec(`
    INSERT INTO agent_templates (slug, name, harness, practices) VALUES
      ('claude-code', 'Claude Code', 'claude-code', '{"skills":["synap","system/synap/capture"]}'),
      ('cursor', 'Cursor', 'cursor', '{"skills":[]}');
    INSERT INTO users (id, user_type, agent_type, agent_template_slug) VALUES
      ('linked', 'agent', 'claude-code', 'claude-code'),
      ('linked-no-skills', 'agent', 'cursor', 'cursor'),
      ('edited', 'agent', 'claude-code', 'claude-code'),
      ('unlinked', 'agent', 'codex', NULL),
      ('computer', 'agent', 'machine', 'claude-code'),
      ('person', 'human', NULL, NULL);
    INSERT INTO agent_configs (user_id, agent_type, preset_key, preset_label, skill_slugs)
      VALUES ('edited', 'claude-code', 'template', 'Mine', '["my-skill"]');
  `);
  await pg.exec(M0406);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

const presets = async () =>
  (
    await pg.query<{
      user_id: string;
      preset_label: string;
      skill_slugs: string[];
    }>(
      `SELECT user_id, preset_label, skill_slugs FROM agent_configs
       WHERE preset_key = 'template' ORDER BY user_id`
    )
  ).rows;

describe("migration 0406 — template practices for agents already linked", () => {
  it("gives each linked agent its template's practices, once, and leaves every other row alone", async () => {
    expect(await presets()).toEqual([
      {
        user_id: "edited",
        preset_label: "Mine",
        skill_slugs: ["my-skill"],
      },
      {
        user_id: "linked",
        preset_label: "From the Claude Code template",
        skill_slugs: ["synap", "system/synap/capture"],
      },
      {
        user_id: "linked-no-skills",
        preset_label: "From the Cursor template",
        skill_slugs: [],
      },
    ]);
  });

  it("writes nothing when run again", async () => {
    const before = await presets();
    await pg.exec(M0406);
    expect(await presets()).toEqual(before);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_configs`
    );
    expect(rows[0]!.n).toBe(3);
  });
});
