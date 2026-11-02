/**
 * REAL-POSTGRES (PGlite) test for migration 0390 — presets per agent (B6):
 *   - on a pod at the pre-0390 shape, the migration (twice: idempotent) gives
 *     `agent_configs` every column the drizzle schema declares, and so does
 *     the baseline; the boot check (`findMissingIndexes`) sees the preset
 *     unique index, and sees it missing without the migration's index
 *     statement; the coherence list carries the table;
 *   - one preset per key per agent (the partial unique index), while the IS
 *     override rows (no preset key) are untouched by it;
 *   - a preset is pod-wide: a preset row with a workspace is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentConfigs } from "./schema/agent-configs.js";
import {
  findMissingIndexes,
  REQUIRED_COLUMNS,
} from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0390_agent_presets.sql";
const M0390 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

/** `agent_configs` as every pod had it before 0390. */
const PRE_0390 = `
  CREATE TABLE workspaces (id uuid PRIMARY KEY);
  CREATE TABLE agent_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_type text NOT NULL,
    prompt_append text,
    extra_tool_ids jsonb NOT NULL DEFAULT '[]',
    disabled_tool_ids jsonb NOT NULL DEFAULT '[]',
    max_steps_override integer,
    model_override text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_configs_user_workspace_agent_unique
      UNIQUE (user_id, workspace_id, agent_type)
  );
  CREATE INDEX agent_configs_user_id_idx ON agent_configs (user_id);
  CREATE INDEX agent_configs_workspace_id_idx ON agent_configs (workspace_id);
  CREATE INDEX agent_configs_agent_type_idx ON agent_configs (agent_type);
`;
const WS = "11111111-1111-4111-8111-111111111111";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(PRE_0390);
  await pg.exec(M0390);
  await pg.exec(M0390);
  await pg.exec(`INSERT INTO workspaces (id) VALUES ('${WS}')`);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_configs'`
    )
  ).rows.map((r) => r.column_name);

const queryOn =
  (client: PGlite) =>
  async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (
      await client.query(
        strings.reduce((sql, s, i) => `${sql}$${i}${s}`),
        values
      )
    ).rows;

const missingOn = async (client: PGlite) =>
  (await findMissingIndexes(queryOn(client) as never)).find(
    (m) => m.table === "agent_configs"
  )?.missing ?? [];

const preset = (user: string, key: string, workspace: string | null = null) =>
  pg.query(
    `INSERT INTO agent_configs (user_id, workspace_id, agent_type, preset_key, preset_label)
     VALUES ($1, $2, 'claude-code', $3, $3)`,
    [user, workspace, key]
  );

describe("migration 0390 — presets per agent", () => {
  it("adds every column the schema declares, and so does the baseline", async () => {
    const declared = getTableConfig(agentConfigs).columns.map((c) => c.name);
    for (const c of [
      "preset_key",
      "preset_label",
      "provider_override",
      "skill_slugs",
    ])
      expect(declared).toContain(c);
    expect((await columns(pg)).sort()).toEqual([...declared].sort());
    const base = new PGlite();
    await base.exec(`CREATE TABLE workspaces (id uuid PRIMARY KEY);`);
    const from = BASELINE.indexOf("-- ─── 33. agent_configs");
    const to = BASELINE.indexOf(
      "CREATE INDEX IF NOT EXISTS idx_users_agent_template"
    );
    expect(from).toBeGreaterThan(0);
    await base.exec(BASELINE.slice(from, to));
    expect((await columns(base)).sort()).toEqual([...declared].sort());
    expect(await missingOn(base)).toEqual([]);
    await base.close();
  });

  it("the boot check sees the preset index, and sees it missing without it", async () => {
    expect(await missingOn(pg)).toEqual([]);
    const bare = new PGlite();
    await bare.exec(PRE_0390);
    await bare.exec(M0390.slice(0, M0390.indexOf("CREATE UNIQUE INDEX")));
    expect(await missingOn(bare)).toEqual(["agent_configs_user_preset_unique"]);
    await bare.close();
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "agent_configs",
        column: "skill_slugs",
        addedBy: FILE,
      })
    );
  });

  it("one preset per key per agent; another agent may use the same key", async () => {
    await preset("agent-a", "reviewer");
    await expect(preset("agent-a", "reviewer")).rejects.toThrow(/unique/i);
    await preset("agent-b", "reviewer");
    // The IS override rows (no preset key) are not presets: never in conflict.
    await pg.query(
      `INSERT INTO agent_configs (user_id, workspace_id, agent_type) VALUES ('agent-a', NULL, 'claude-code'), ('agent-a', NULL, 'claude-code')`
    );
  });

  it("a preset is pod-wide: a preset row with a workspace is refused", async () => {
    await expect(preset("agent-a", "editor", WS)).rejects.toThrow(
      /agent_configs_preset_pod_wide/
    );
  });
});
