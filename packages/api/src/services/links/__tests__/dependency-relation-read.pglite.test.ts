/**
 * THE relation read projection of the dependency edge, with every predicate
 * compiled and executed as SQL on PGlite — and driven through the real
 * `relations.list` / `relations.get` procedures, so the seam between the
 * projection and the readers is under test, not hand-built.
 *
 * Pins: since 0301 a `blocks` / `depends_on` relation is a `links` `blocked_by`
 * row, and every relation reader returns it (slug + direction it was drawn
 * under, the LINK id, `storedAs: "link"`, the 0301 legacy id) — while an edge
 * whose far end the reader cannot see is NOT a relation they may read.
 *
 * What this CANNOT see: production Postgres (PGlite tables here carry no FKs,
 * defaults or enums), and the project-lens variant of the entity floor.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schemaModule = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schemaModule });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { AccessContext } from "../../../access/index.js";
import { readDependencyRelations } from "../dependency-relation-read.js";
import { relationsRouter } from "../../../routers/relations.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const A = randomUUID(); // waits
const B = randomUUID(); // blocker, visible
const H = randomUUID(); // blocker, invisible to VIEWER
const SESSION = randomUUID();
const LEGACY = randomUUID();
const LINK_AB = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Seen',$3),($2,'Hidden',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER, randomUUID(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into entities (id, title, user_id, workspace_id) values ($1,'A',$4,$5),($2,'B',$4,$5),($3,'H',$6,$7)`,
    [A, B, H, VIEWER, WS_SEEN, OTHER, WS_HIDDEN]
  );
  // A --blocked_by--> B, migrated by 0301 from `B --blocks--> A`.
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
     values ($1,$2,'entity',$3,'entity',$4,'blocked_by',$5,$6, now())`,
    [
      LINK_AB,
      WS_SEEN,
      A,
      B,
      JSON.stringify({
        relationType: "blocks",
        migratedFromRelationId: LEGACY,
      }),
      VIEWER,
    ]
  );
  // A --blocked_by--> H: the far end is invisible to VIEWER.
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
     values ($1,$2,'entity',$3,'entity',$4,'blocked_by','{}',$5, now())`,
    [randomUUID(), WS_SEEN, A, H, VIEWER]
  );
  // A session dependency is not an entity relation.
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
     values ($1,$2,'entity',$3,'session',$4,'blocked_by','{}',$5, now())`,
    [randomUUID(), WS_SEEN, A, SESSION, VIEWER]
  );
});

const viewer = () => AccessContext.operator({ userId: VIEWER });

describe("readDependencyRelations — the one projection", () => {
  it("returns the visible edge, relation-shaped, in the slug + direction it was drawn", async () => {
    const rows = await readDependencyRelations({ access: viewer() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: LINK_AB,
      storedAs: "link",
      type: "blocks",
      sourceEntityId: B,
      targetEntityId: A,
      legacyRelationId: LEGACY,
      workspaceId: WS_SEEN,
    });
  });

  it("never returns an edge whose far end the reader cannot see", async () => {
    const rows = await readDependencyRelations({
      access: viewer(),
      touching: { entityIds: [A], mode: "either" },
    });
    expect(rows.map((r) => r.targetEntityId)).not.toContain(H);
    expect(rows.map((r) => r.sourceEntityId)).not.toContain(H);
    // …and the owner of H sees nothing either: A is not theirs to see.
    const other = await readDependencyRelations({
      access: AccessContext.operator({ userId: OTHER }),
    });
    expect(other).toEqual([]);
  });

  it("touching 'both' keeps only internal edges; the slug filter mirrors the projection", async () => {
    const only = (o: Parameters<typeof readDependencyRelations>[0]) =>
      readDependencyRelations(o).then((r) => r.length);
    expect(
      await only({
        access: viewer(),
        touching: { entityIds: [A, B], mode: "both" },
      })
    ).toBe(1);
    expect(
      await only({
        access: viewer(),
        touching: { entityIds: [A], mode: "both" },
      })
    ).toBe(0);
    expect(await only({ access: viewer(), type: "blocks" })).toBe(1);
    expect(await only({ access: viewer(), type: "depends_on" })).toBe(0);
    expect(await only({ access: viewer(), type: "works_with" })).toBe(0);
  });

  it("the lens narrows the edge's workspace", async () => {
    expect(
      await readDependencyRelations({ access: viewer().withLens(WS_HIDDEN) })
    ).toEqual([]);
  });
});

describe("the relation readers return it (the seam)", () => {
  const caller = relationsRouter.createCaller({
    authenticated: true,
    userId: VIEWER,
  } as never);

  it("relations.list carries the dependency with its link id", async () => {
    const { relations } = await caller.list({ limit: 100, offset: 0 });
    expect(relations).toContainEqual(
      expect.objectContaining({ id: LINK_AB, type: "blocks", storedAs: "link" })
    );
  });

  it("relations.get honours direction on the relation reading", async () => {
    const asSource = await caller.get({
      entityId: B,
      direction: "source",
      limit: 50,
    });
    expect(asSource.relations.map((r) => r.id)).toContain(LINK_AB);
    const asTarget = await caller.get({
      entityId: B,
      direction: "target",
      limit: 50,
    });
    expect(asTarget.relations.map((r) => r.id)).not.toContain(LINK_AB);
  });
});
