/**
 * `unlinkProjectFromWorkspace` — the remove half of `project --uses--> workspace`.
 *
 * Driven through the REAL function on PGlite, with the real
 * `ownerPrivateVisibleWhere` predicate compiled and executed as SQL. Pins:
 *   - the owner removes exactly the `uses` edge of that pair (RETURNING count);
 *   - other edges survive: the same pair under another link type, and the
 *     project's `uses` edge to a different workspace;
 *   - a caller who cannot see the project is refused and removes nothing;
 *   - an edge to a workspace row that no longer exists is still removable (the
 *     reason this door exists: a `uses` edge to a retired workspace);
 *   - a second call is a calm `rows: 0`, not an error.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { unlinkProjectFromWorkspace } from "./project-workspace.js";

const OWNER = "owner-1";
const STRANGER = "stranger-1";

const WS_KEEP = randomUUID();
const WS_DROP = randomUUID();
const WS_GONE = randomUUID(); // no workspaces row — a retired workspace
const PROJECT_ID = randomUUID();

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

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const edges = async () =>
  (
    await q<{ to_id: string; link_type: string }>(
      `select to_id, link_type from links where from_id = $1 order by to_id, link_type`,
      [PROJECT_ID]
    )
  ).rows;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Keep',$3),($2,'Drop',$3)`,
    [WS_KEEP, WS_DROP, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS_KEEP, OWNER]
  );
  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'P',$2,$3)`,
    [PROJECT_ID, OWNER, WS_KEEP]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values
      ($1,'project',$4,'workspace',$5,'uses'),
      ($2,'project',$4,'workspace',$6,'uses'),
      ($3,'project',$4,'workspace',$6,'targets'),
      ($7,'project',$4,'workspace',$8,'uses')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      PROJECT_ID,
      WS_KEEP,
      WS_DROP,
      randomUUID(),
      WS_GONE,
    ]
  );
});

const db = async () => (await import("@synap/database")).db as never;

describe("unlinkProjectFromWorkspace", () => {
  it("a caller who cannot see the project is refused and removes nothing", async () => {
    const before = await edges();
    const res = await unlinkProjectFromWorkspace(await db(), {
      projectId: PROJECT_ID,
      workspaceId: WS_DROP,
      userId: STRANGER,
    });
    expect(res).toEqual({ unlinked: false, reason: "project_not_found" });
    expect(await edges()).toEqual(before);
  });

  it("the owner removes exactly the uses edge of that pair", async () => {
    const res = await unlinkProjectFromWorkspace(await db(), {
      projectId: PROJECT_ID,
      workspaceId: WS_DROP,
      userId: OWNER,
    });
    expect(res).toEqual({ unlinked: true, rows: 1 });
    const left = await edges();
    // The `targets` edge to the same workspace and the other `uses` edges stay.
    expect(left).toContainEqual({ to_id: WS_DROP, link_type: "targets" });
    expect(left).toContainEqual({ to_id: WS_KEEP, link_type: "uses" });
    expect(left).not.toContainEqual({ to_id: WS_DROP, link_type: "uses" });
    expect(left).toHaveLength(3);
  });

  it("a second call is a calm rows:0", async () => {
    const res = await unlinkProjectFromWorkspace(await db(), {
      projectId: PROJECT_ID,
      workspaceId: WS_DROP,
      userId: OWNER,
    });
    expect(res).toEqual({ unlinked: true, rows: 0 });
  });

  it("an edge to a workspace row that no longer exists is still removable", async () => {
    const res = await unlinkProjectFromWorkspace(await db(), {
      projectId: PROJECT_ID,
      workspaceId: WS_GONE,
      userId: OWNER,
    });
    expect(res).toEqual({ unlinked: true, rows: 1 });
    expect(await edges()).not.toContainEqual({
      to_id: WS_GONE,
      link_type: "uses",
    });
  });
});
