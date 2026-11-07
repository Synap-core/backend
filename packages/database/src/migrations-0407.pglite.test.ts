/**
 * REAL-POSTGRES (PGlite) test for migration 0407 — an agent template's
 * starting MCP tool surface (finding d812debd):
 *   - on a pod at the 0404 shape, the migration (twice: idempotent) adds
 *     `tool_profile` (NULL) and `tool_groups` (NOT NULL, default []); the
 *     coherence list carries `tool_groups`;
 *   - a template installed before it gets `toolProfile: null` and
 *     `toolGroups: []` in its keep/drop baseline, so the next catalog update
 *     that brings a surface APPLIES (the three-way merge reads a field missing
 *     from the baseline as newly managed, and the live value as the person's);
 *     a baseline that already has them, and a row with no baseline, are left
 *     as they are.
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
const FILE = "0407_agent_template_tool_surface.sql";
const M0407 = read(FILE);

const BASE = { harness: "hermes", aliases: [], worker: true };
const market = (baseline: Record<string, unknown>) =>
  JSON.stringify({
    marketSource: { packageSlug: "hermes", packageVersion: "1.0.0", baseline },
    keep: "me",
  });

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE users (id text PRIMARY KEY, agent_type text);`);
  await pg.exec(read("0404_agent_templates.sql"));
  await pg.query(
    `INSERT INTO agent_templates (slug, name, harness, metadata) VALUES
       ('before', 'Before', 'hermes', $1::jsonb),
       ('already', 'Already', 'codex', $2::jsonb),
       ('no-source', 'No source', 'cursor', '{"keep":"me"}'::jsonb)`,
    [
      market(BASE),
      market({ ...BASE, toolProfile: "entry", toolGroups: ["read"] }),
    ]
  );
  await pg.exec(M0407);
  await pg.exec(M0407);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const meta = async (slug: string) =>
  (
    await pg.query<{ metadata: Record<string, any> }>(
      `SELECT metadata FROM agent_templates WHERE slug = $1`,
      [slug]
    )
  ).rows[0]!.metadata;

describe("migration 0407 — agent template tool surface", () => {
  it("adds tool_profile (null) and tool_groups ([]) to every row; coherence carries it", async () => {
    const rows = (
      await pg.query<{ tool_profile: string | null; tool_groups: unknown }>(
        `SELECT tool_profile, tool_groups FROM agent_templates`
      )
    ).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.tool_profile).toBeNull();
      expect(r.tool_groups).toEqual([]);
    }
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "agent_templates",
        column: "tool_groups",
        addedBy: FILE,
      })
    );
  });

  it("a baseline without the fields gets null and [], the rest of the bag kept", async () => {
    const m = await meta("before");
    expect(m.marketSource.baseline).toEqual({
      ...BASE,
      toolProfile: null,
      toolGroups: [],
    });
    expect(m.marketSource.packageVersion).toBe("1.0.0");
    expect(m.keep).toBe("me");
  });

  it("a baseline that has them, and a row with no baseline, are untouched", async () => {
    expect((await meta("already")).marketSource.baseline).toEqual({
      ...BASE,
      toolProfile: "entry",
      toolGroups: ["read"],
    });
    expect(await meta("no-source")).toEqual({ keep: "me" });
  });
});
