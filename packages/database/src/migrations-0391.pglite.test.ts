/**
 * REAL-POSTGRES (PGlite) test for migration 0391 — `related_to` → `relates_to`
 * in the two link stores that can hold it (`relations`,
 * `entity_relationships`), with their real unique keys (0239's two partial
 * indexes; `entity_relationships_unique`):
 *   - every `related_to` row takes the canonical spelling;
 *   - a `related_to` twin of an edge already stored as `relates_to` (same
 *     unique key) is removed instead of colliding; a row that only LOOKS like
 *     a twin (another owner's pod-wide edge, another workspace) is renamed;
 *   - idempotent: a second run changes nothing;
 *   - a pod that DEFINES a `related_to` relation keeps its `relations` rows
 *     (they are that def's edges), while `entity_relationships` converges.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0391 = readFileSync(
  resolve(HERE, "../migrations/0391_relation_type_relates_to.sql"),
  "utf8"
);

/** The three tables as a pod holds them before 0391 (keys that matter only). */
const PRE_0391 = `
  CREATE TABLE relation_defs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL,
    workspace_id uuid
  );
  CREATE TABLE relations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    workspace_id uuid,
    source_entity_id uuid,
    target_entity_id uuid,
    type text NOT NULL,
    source_kind text NOT NULL DEFAULT 'entity',
    target_kind text NOT NULL DEFAULT 'entity',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX relations_entity_edge_ws_unique
    ON relations (source_entity_id, target_entity_id, type, workspace_id)
    WHERE source_kind = 'entity' AND target_kind = 'entity'
      AND source_entity_id IS NOT NULL AND target_entity_id IS NOT NULL
      AND workspace_id IS NOT NULL;
  CREATE UNIQUE INDEX relations_entity_edge_pod_unique
    ON relations (source_entity_id, target_entity_id, type, user_id)
    WHERE source_kind = 'entity' AND target_kind = 'entity'
      AND source_entity_id IS NOT NULL AND target_entity_id IS NOT NULL
      AND workspace_id IS NULL;
  CREATE TABLE entity_relationships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id uuid NOT NULL,
    target_entity_id uuid NOT NULL,
    relationship_type text NOT NULL,
    user_id text NOT NULL,
    CONSTRAINT entity_relationships_unique
      UNIQUE (source_entity_id, target_entity_id, relationship_type)
  );
`;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

async function seed(pg: PGlite) {
  await pg.exec(PRE_0391);
  await pg.exec(`
    INSERT INTO relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) VALUES
      -- W1: an edge under BOTH spellings → the related_to twin goes
      ('00000000-0000-4000-8000-000000000001', 'u1', '${W1}', '${A}', '${B}', 'relates_to'),
      ('00000000-0000-4000-8000-000000000002', 'u1', '${W1}', '${A}', '${B}', 'related_to'),
      -- W2: the same endpoints in ANOTHER workspace → not a twin, renamed
      ('00000000-0000-4000-8000-000000000003', 'u1', '${W2}', '${A}', '${B}', 'related_to'),
      -- pod-wide: u1 holds relates_to, u2 holds related_to → another owner, renamed
      ('00000000-0000-4000-8000-000000000004', 'u1', NULL, '${A}', '${C}', 'relates_to'),
      ('00000000-0000-4000-8000-000000000005', 'u2', NULL, '${A}', '${C}', 'related_to'),
      -- pod-wide twin of the SAME owner → goes
      ('00000000-0000-4000-8000-000000000006', 'u1', NULL, '${A}', '${C}', 'related_to'),
      -- an unrelated type is never touched
      ('00000000-0000-4000-8000-000000000007', 'u1', '${W1}', '${B}', '${C}', 'works_at');
    INSERT INTO entity_relationships (source_entity_id, target_entity_id, relationship_type, user_id) VALUES
      ('${A}', '${B}', 'relates_to', 'u1'),
      ('${A}', '${B}', 'related_to', 'u1'),
      ('${B}', '${C}', 'related_to', 'u1'),
      ('${B}', '${C}', 'part_of', 'u1');
  `);
}

const relationsOf = async (pg: PGlite) =>
  (
    await pg.query<{ id: string; type: string }>(
      `SELECT id, type FROM relations ORDER BY id`
    )
  ).rows.map((r) => [r.id.slice(-1), r.type]);

const enrichmentsOf = async (pg: PGlite) =>
  (
    await pg.query<{ s: string; t: string; type: string }>(
      `SELECT left(source_entity_id::text, 1) AS s, left(target_entity_id::text, 1) AS t, relationship_type AS type
       FROM entity_relationships ORDER BY 1, 2, 3`
    )
  ).rows.map((r) => [r.s, r.t, r.type]);

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await seed(pg);
  await pg.exec(M0391);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0391 — related_to → relates_to", () => {
  it("relations: renamed, a same-key twin removed, look-alikes kept", async () => {
    expect(await relationsOf(pg)).toEqual([
      ["1", "relates_to"],
      ["3", "relates_to"],
      ["4", "relates_to"],
      ["5", "relates_to"],
      ["7", "works_at"],
    ]);
  });

  it("entity_relationships: renamed, the twin removed", async () => {
    expect(await enrichmentsOf(pg)).toEqual([
      ["a", "b", "relates_to"],
      ["b", "c", "part_of"],
      ["b", "c", "relates_to"],
    ]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = [await relationsOf(pg), await enrichmentsOf(pg)];
    await pg.exec(M0391);
    expect([await relationsOf(pg), await enrichmentsOf(pg)]).toEqual(before);
  });

  it("a pod that defines `related_to` keeps those relations; enrichments still converge", async () => {
    const defined = new PGlite();
    await seed(defined);
    await defined.exec(
      `INSERT INTO relation_defs (slug, workspace_id) VALUES ('related_to', '${W1}')`
    );
    const relationsBefore = await relationsOf(defined);
    await defined.exec(M0391);
    expect(await relationsOf(defined)).toEqual(relationsBefore);
    expect(await enrichmentsOf(defined)).toEqual([
      ["a", "b", "relates_to"],
      ["b", "c", "part_of"],
      ["b", "c", "relates_to"],
    ]);
    await defined.close();
  });
});
