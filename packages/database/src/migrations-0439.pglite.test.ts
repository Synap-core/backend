/**
 * REAL-POSTGRES (PGlite) test for migration 0439 — every project's HOME is one
 * of its pillars (`project --uses--> workspace`, ticket d6636ed2).
 *
 * The fixtures each rule a wrong migration out:
 *   - a project with a home and no edge — a migration that does nothing leaves
 *     it without its pillar;
 *   - a project whose home edge already exists WITH a purpose — a migration
 *     that rewrites instead of skipping loses the purpose (or aborts on the
 *     unique edge);
 *   - a pod-personal project (no home) — a migration that guesses a space adds
 *     an edge nobody asked for;
 *   - a project whose home space no longer exists — a migration without the
 *     existence check writes a dangling edge;
 *   - running it twice — a non-idempotent migration duplicates or errors.
 * The `links` table is the baseline's own DDL, unique index included.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0439 = read("0439_backfill_project_home_uses_edges.sql");
const BASELINE = read("0000_baseline_schema.sql");
const LINKS_DDL = BASELINE.slice(
  BASELINE.indexOf('CREATE TABLE IF NOT EXISTS "links"'),
  BASELINE.indexOf(
    '("from_type", "from_id", "to_type", "to_id", "link_type");'
  ) + '("from_type", "from_id", "to_type", "to_id", "link_type");'.length
);

const WS_HOME = "11111111-1111-4111-8111-111111111111";
const WS_GONE = "22222222-2222-4222-8222-222222222222";
const P_BARE = "00000000-0000-4000-8000-000000000001";
const P_HAS_EDGE = "00000000-0000-4000-8000-000000000002";
const P_PERSONAL = "00000000-0000-4000-8000-000000000003";
const P_GONE_HOME = "00000000-0000-4000-8000-000000000004";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE projects (id uuid PRIMARY KEY, workspace_id uuid, name text NOT NULL);
    ${LINKS_DDL}
  `);
  await pg.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'Home')`, [
    WS_HOME,
  ]);
  await pg.query(
    `INSERT INTO projects (id, workspace_id, name) VALUES
       ($1, $5, 'bare'), ($2, $5, 'has edge'), ($3, NULL, 'personal'), ($4, $6, 'gone home')`,
    [P_BARE, P_HAS_EDGE, P_PERSONAL, P_GONE_HOME, WS_HOME, WS_GONE]
  );
  await pg.query(
    `INSERT INTO links (workspace_id, from_type, from_id, to_type, to_id, link_type, metadata)
     VALUES ($1, 'project', $2, 'workspace', $1, 'uses', '{"purpose":"Win clients"}'::jsonb)`,
    [WS_HOME, P_HAS_EDGE]
  );
}, 60_000);

describe("migration 0439 — a project's home is one of its pillars", () => {
  it("non-vacuity: the baseline links DDL carries the unique edge index", () => {
    expect(LINKS_DDL).toContain('CREATE TABLE IF NOT EXISTS "links"');
    expect(LINKS_DDL).toContain("idx_links_unique_edge");
  });

  it("stamps the missing home edge, keeps the existing one, guesses nothing; twice is a no-op", async () => {
    await pg.exec(M0439);
    await pg.exec(M0439);
    const rows = await pg.query<{
      workspace_id: string;
      from_id: string;
      to_id: string;
      metadata: Record<string, unknown>;
      created_by: string | null;
    }>(
      `SELECT workspace_id, from_id, to_id, metadata, created_by FROM links
       WHERE from_type = 'project' AND to_type = 'workspace' AND link_type = 'uses'
       ORDER BY from_id`
    );
    expect(rows.rows).toEqual([
      // The door's shape: the space as the link's workspace, no purpose, no author.
      {
        workspace_id: WS_HOME,
        from_id: P_BARE,
        to_id: WS_HOME,
        metadata: {},
        created_by: null,
      },
      // Untouched: its purpose survives.
      {
        workspace_id: WS_HOME,
        from_id: P_HAS_EDGE,
        to_id: WS_HOME,
        metadata: { purpose: "Win clients" },
        created_by: null,
      },
    ]);
  });
});
