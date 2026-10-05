/**
 * `entities.listMulti` × `projectId` — the lens model's "this space × this
 * project" read (BRIEF-lens-model), on PGlite through the REAL procedure, the
 * real membership check (`validateWorkspaceAccess`) and the real project
 * predicate (`projectLensWhere`, `belongs_to_project`). Nothing hand-built
 * between the rows and the answer.
 *
 *   WS  — one Content space holding two projects' items (P and Q) + an
 *         unfiled one.
 *   WO  — another of A's spaces, holding a P item: a project lens must NOT
 *         pull it in (intersection, never the project across spaces).
 *
 * What this CANNOT see: production Postgres (DDL is generated from the Drizzle
 * tables), facet/role lens rows (none seeded), member-shared entities (the
 * repository floors on `entities.userId`, unchanged here).
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
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { router } from "../../trpc.js";
import { readProcs } from "./read.js";

const testRouter = router({ listMulti: readProcs.listMulti });

const A = randomUUID();
const WS = randomUUID(); // the Content space
const WO = randomUUID(); // another of A's spaces
const P = randomUUID();
const Q = randomUUID();
const KIND = randomUUID();

const E_P = randomUUID(); // WS, in P
const E_Q = randomUUID(); // WS, in Q
const E_NONE = randomUUID(); // WS, in no project
const E_WO_P = randomUUID(); // WO, in P — outside the space

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function listMulti(input: {
  workspaceIds?: string[];
  projectId?: string;
  withoutProject?: boolean;
}): Promise<Set<string>> {
  const res = await testRouter
    .createCaller({
      authenticated: true,
      userId: A,
      workspaceId: null,
    } as never)
    .listMulti({ ...input, profileSlug: "thing" });
  return new Set(res.entities.map((e) => e.id));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, $2)`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  for (const ws of [WS, WO]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
      [ws, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1,$2,null,'P','active'),($3,$2,null,'Q','active')`,
    [P, A, Q]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system')`,
    [KIND]
  );
  for (const [id, ws] of [
    [E_P, WS],
    [E_Q, WS],
    [E_NONE, WS],
    [E_WO_P, WO],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, version) values ($1,$2,$3,$4,'thing','e','{}'::jsonb,1)`,
      [id, A, ws, KIND]
    );
  }
  for (const [src, ws, project] of [
    [E_P, WS, P],
    [E_Q, WS, Q],
    [E_WO_P, WO, P],
  ] as const) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), A, ws, src, project]
    );
  }
}, 120_000);

describe("entities.listMulti — this space × this project", () => {
  it("no project ⇒ everything in the space (both projects' items + the unfiled one)", async () => {
    expect(await listMulti({ workspaceIds: [WS] })).toEqual(
      new Set([E_P, E_Q, E_NONE])
    );
  });

  it("project P ⇒ only P's items IN THIS SPACE (Q's and the unfiled one drop out)", async () => {
    expect(await listMulti({ workspaceIds: [WS], projectId: P })).toEqual(
      new Set([E_P])
    );
    expect(await listMulti({ workspaceIds: [WS], projectId: Q })).toEqual(
      new Set([E_Q])
    );
  });

  it("the project only NARROWS: P's item in another space is never pulled in", async () => {
    const got = await listMulti({ workspaceIds: [WS], projectId: P });
    expect(got.has(E_WO_P)).toBe(false);
    // …while that space read under P does return it (the predicate is live).
    expect(await listMulti({ workspaceIds: [WO], projectId: P })).toEqual(
      new Set([E_WO_P])
    );
  });

  it("a project with no items in the space ⇒ empty, not the whole space", async () => {
    expect(
      await listMulti({ workspaceIds: [WS], projectId: randomUUID() })
    ).toEqual(new Set());
  });

  it("withoutProject ⇒ only the rows in NO project (the unfiled one)", async () => {
    expect(
      await listMulti({ workspaceIds: [WS], withoutProject: true })
    ).toEqual(new Set([E_NONE]));
  });
});
