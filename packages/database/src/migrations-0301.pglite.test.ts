/**
 * REAL-POSTGRES (PGlite) test for migration 0301 — entity relations `blocks` /
 * `depends_on` move onto THE dependency edge (links `blocked_by`).
 *
 * The fixtures are chosen so each one rules a wrong migration out:
 *   - `blocks` and `depends_on` rows with OPPOSITE direction rules — a
 *     migration that copies source→from for both fails one of them;
 *   - a `blocks` + `depends_on` pair naming the SAME dependency — a migration
 *     without the unique-edge conflict lands two rows (or aborts);
 *   - a cell-endpoint row and an unrelated slug — a migration that moves too
 *     much deletes them;
 *   - the blocked entity's workspace differs from the relation's — a migration
 *     that stamps the relation's workspace disagrees with the door;
 *   - running it twice — a non-idempotent migration duplicates or errors.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0301 = readFileSync(
  resolve(HERE, "../migrations/0301_relations_dependency_to_links.sql"),
  "utf8"
);

const E = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const WS_REL = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE entities (id uuid PRIMARY KEY, workspace_id uuid);
    CREATE TABLE relations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      workspace_id uuid,
      source_entity_id uuid,
      target_entity_id uuid,
      source_kind text NOT NULL DEFAULT 'entity',
      target_kind text NOT NULL DEFAULT 'entity',
      source_cell_id uuid,
      target_cell_id uuid,
      type text NOT NULL,
      metadata jsonb DEFAULT '{}',
      created_by_kind text,
      created_by_user_id text,
      agent_user_id text,
      source_proposal_id uuid,
      correlation_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      workspace_id uuid,
      from_type text NOT NULL,
      from_id text NOT NULL,
      to_type text NOT NULL,
      to_id text NOT NULL,
      link_type text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX idx_links_unique_edge
      ON links (from_type, from_id, to_type, to_id, link_type);

    INSERT INTO entities (id, workspace_id) VALUES
      ('${E(1)}', '${WS_REL}'), ('${E(2)}', '${WS_B}'),
      ('${E(3)}', '${WS_REL}'), ('${E(4)}', '${WS_REL}'),
      ('${E(5)}', '${WS_REL}');

    -- 1 blocks 2  ⇒  2 blocked_by 1 (blocked end 2 lives in WS_B)
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_by_kind, agent_user_id, created_by_user_id)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'owner', '${WS_REL}', '${E(1)}', '${E(2)}', 'blocks', 'ai_agent', 'agent-7', 'approver');
    -- 3 depends_on 4  ⇒  3 blocked_by 4
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 'owner', '${WS_REL}', '${E(3)}', '${E(4)}', 'depends_on');
    -- 4 blocks 3  ⇒  3 blocked_by 4 again (same dependency, second name)
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000003', 'owner', '${WS_REL}', '${E(4)}', '${E(3)}', 'blocks');
    -- untouched: another slug, and a cell-endpoint dependency
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000004', 'owner', '${WS_REL}', '${E(1)}', '${E(5)}', 'relates_to');
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, source_kind, source_cell_id, type)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000005', 'owner', '${WS_REL}', NULL, '${E(5)}', 'cell', gen_random_uuid(), 'depends_on');
  `);
}, 120_000);

describe("migration 0301 — blocks/depends_on relations → links blocked_by", () => {
  it("moves each dependency with the right direction, workspace and provenance; re-run is a no-op", async () => {
    await pg.exec(M0301);
    await pg.exec(M0301); // idempotent

    const edges = await pg.query<{
      from_id: string;
      to_id: string;
      workspace_id: string;
      created_by: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT from_id, to_id, workspace_id, created_by, metadata FROM links
        WHERE link_type = 'blocked_by' AND from_type = 'entity' AND to_type = 'entity'
        ORDER BY from_id`
    );
    expect(edges.rows.map((r) => [r.from_id, r.to_id])).toEqual([
      [E(2), E(1)], // 1 blocks 2
      [E(3), E(4)], // 3 depends_on 4 ≡ 4 blocks 3 — ONE edge
    ]);
    const blocksEdge = edges.rows[0]!;
    // The BLOCKED end's workspace, not the relation's.
    expect(blocksEdge.workspace_id).toBe(WS_B);
    expect(blocksEdge.created_by).toBe("approver");
    expect(blocksEdge.metadata).toMatchObject({
      relationType: "blocks",
      migratedFromRelationId: "aaaaaaaa-0000-4000-8000-000000000001",
      createdByKind: "ai_agent",
      agentUserId: "agent-7",
    });
    expect(blocksEdge.metadata).not.toHaveProperty("correlationId");
  });

  it("deletes exactly the moved relation rows", async () => {
    const left = await pg.query<{ id: string; type: string }>(
      `SELECT id, type FROM relations ORDER BY id`
    );
    expect(left.rows.map((r) => r.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000004", // relates_to — not a dependency
      "aaaaaaaa-0000-4000-8000-000000000005", // cell endpoint — not a unit of work
    ]);
  });
});
