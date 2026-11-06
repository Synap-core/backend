/**
 * REAL-POSTGRES (PGlite) test for migration 0404 — agent templates installed
 * by the catalog (founder decision D8) and the agent → template link:
 *   - on a pod at the pre-0404 shape, the migration (twice: idempotent) gives
 *     `agent_templates` every column the drizzle schema declares, and so does
 *     the baseline; `users` gains `agent_template_slug`;
 *   - the boot check (`findMissingIndexes`) sees the slug unique index, and
 *     sees it missing without the migration's index statement (the install's
 *     ON CONFLICT relies on it); the coherence list carries the columns;
 *   - one installed template per slug.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentTemplates } from "./schema/agent-templates.js";
import {
  findMissingIndexes,
  REQUIRED_COLUMNS,
} from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0404_agent_templates.sql";
const M0404 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

const PRE_0404 = `CREATE TABLE users (id text PRIMARY KEY, agent_type text);`;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(PRE_0404);
  await pg.exec(M0404);
  await pg.exec(M0404);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const columns = async (client: PGlite, table: string) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
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
    (m) => m.table === "agent_templates"
  )?.missing ?? [];

describe("migration 0404 — agent templates", () => {
  it("adds every column the schema declares, and so does the baseline", async () => {
    const declared = getTableConfig(agentTemplates).columns.map((c) => c.name);
    expect((await columns(pg, "agent_templates")).sort()).toEqual(
      [...declared].sort()
    );
    expect(await columns(pg, "users")).toContain("agent_template_slug");

    const base = new PGlite();
    await base.exec(PRE_0404);
    const from = BASELINE.indexOf("-- ─── 33b. agent_templates (0404)");
    const to = BASELINE.indexOf("-- ─── 34. intelligence_services");
    expect(from).toBeGreaterThan(0);
    await base.exec(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_template_slug text;`
    );
    await base.exec(BASELINE.slice(from, to));
    expect((await columns(base, "agent_templates")).sort()).toEqual(
      [...declared].sort()
    );
    expect(await missingOn(base)).toEqual([]);
    await base.close();
    expect(BASELINE).toContain(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_template_slug" text;`
    );
  });

  it("the boot check sees the slug index, and sees it missing without it", async () => {
    expect(await missingOn(pg)).toEqual([]);
    const bare = new PGlite();
    await bare.exec(PRE_0404);
    await bare.exec(M0404.slice(0, M0404.indexOf("CREATE UNIQUE INDEX")));
    expect(await missingOn(bare)).toContain("agent_templates_slug_unique");
    await bare.close();
    for (const [table, column] of [
      ["users", "agent_template_slug"],
      ["agent_templates", "wake"],
    ])
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({ table, column, addedBy: FILE })
      );
  });

  it("one installed template per slug", async () => {
    const add = () =>
      pg.query(
        `INSERT INTO agent_templates (slug, name, harness) VALUES ('claude-code', 'Claude Code', 'claude-code')`
      );
    await add();
    await expect(add()).rejects.toThrow(/unique/i);
  });
});
