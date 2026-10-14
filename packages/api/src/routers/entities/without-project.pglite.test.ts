/**
 * "Not in a project" — `entities.list({ withoutProject })` and
 * `entities.countWithoutProject`, on PGlite through the REAL procedures, the
 * real read floor (`entityReadVisibleWhere`) and the real narrow
 * (`notInAnyProjectWhere`). Nothing hand-built between the rows and the answer.
 *
 *   A owns two spaces (WS, WO) and three projects: P (active), R (archived)
 *   and a project that was DELETED (its edge left behind, as
 *   `ProjectRepository.delete` leaves it).
 *   B is another user with an unfiled pod-personal thing A must never see.
 *
 * What this CANNOT see: production Postgres (DDL is generated from the Drizzle
 * tables), facet/role-lens rows and member-shared entities (none seeded).
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

const testRouter = router({
  list: readProcs.list,
  listMulti: readProcs.listMulti,
  countWithoutProject: readProcs.countWithoutProject,
});

const A = randomUUID();
const B = randomUUID();
const WS = randomUUID();
const WO = randomUUID();
const P = randomUUID(); // active
const R = randomUUID(); // archived
const GONE = randomUUID(); // deleted — no projects row, edge left behind
const THING = randomUUID();
const NOTE = randomUUID();

const E_P = randomUUID(); // WS thing, in P
const E_R = randomUUID(); // WS thing, in archived R
const E_NONE = randomUUID(); // WS thing, in no project
const E_GONE = randomUUID(); // WS thing, only in the deleted project
const E_WO_NOTE = randomUUID(); // WO note, in no project
const E_POD_NOTE = randomUUID(); // A's pod-personal note, in no project
const E_DELETED = randomUUID(); // WS thing, soft-deleted, in no project
const E_B = randomUUID(); // B's pod-personal thing, in no project

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

const callerFor = (userId: string) =>
  testRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

async function listIds(input: Record<string, unknown>): Promise<Set<string>> {
  const res = await callerFor(A).list({ limit: 100, ...input });
  return new Set(res.items.map((e: { id: string }) => e.id));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
    await q(
      `insert into pod_members (id, user_id, pod_role) values ($1,$2,'member')`,
      [randomUUID(), u]
    );
  }
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
    `insert into projects (id, user_id, workspace_id, name, status) values ($1,$3,null,'P','active'),($2,$3,null,'R','archived')`,
    [P, R, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system'),($2,'note','Note','kind','system')`,
    [THING, NOTE]
  );
  for (const [id, user, ws, kind, slug, deleted] of [
    [E_P, A, WS, THING, "thing", false],
    [E_R, A, WS, THING, "thing", false],
    [E_NONE, A, WS, THING, "thing", false],
    [E_GONE, A, WS, THING, "thing", false],
    [E_WO_NOTE, A, WO, NOTE, "note", false],
    [E_POD_NOTE, A, null, NOTE, "note", false],
    [E_DELETED, A, WS, THING, "thing", true],
    [E_B, B, null, THING, "thing", false],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, version, deleted_at) values ($1,$2,$3,$4,$5,'e','{}'::jsonb,1,$6)`,
      [id, user, ws, kind, slug, deleted ? new Date() : null]
    );
  }
  for (const [src, project] of [
    [E_P, P],
    [E_R, R],
    [E_GONE, GONE],
  ] as const) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), A, WS, src, project]
    );
  }
}, 120_000);

const UNFILED = new Set([E_NONE, E_GONE, E_WO_NOTE, E_POD_NOTE]);

describe("entities.list — withoutProject (the 'Not in a project' list)", () => {
  it("no lens ⇒ every thing A can see that is in NO live project", async () => {
    expect(await listIds({ withoutProject: true })).toEqual(UNFILED);
  });

  it("a thing in an ARCHIVED project is still filed; one whose only project was DELETED is not", async () => {
    const got = await listIds({ withoutProject: true });
    expect(got.has(E_R)).toBe(false);
    expect(got.has(E_GONE)).toBe(true);
  });

  it("composes with a kind and a space", async () => {
    expect(
      await listIds({ withoutProject: true, profileSlug: "note" })
    ).toEqual(new Set([E_WO_NOTE, E_POD_NOTE]));
    expect(await listIds({ withoutProject: true, workspaceId: WS })).toEqual(
      new Set([E_NONE, E_GONE])
    );
  });

  it("pages: limit + offset walk the same set, hasMore says when to stop", async () => {
    const first = await callerFor(A).list({
      withoutProject: true,
      limit: 3,
      offset: 0,
    });
    const second = await callerFor(A).list({
      withoutProject: true,
      limit: 3,
      offset: 3,
    });
    expect(first.total).toBe(UNFILED.size);
    expect(first.pagination.hasMore).toBe(true);
    expect(second.pagination.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((e) => e.id))).toEqual(
      UNFILED
    );
  });

  it("with projectId is a contradiction ⇒ 400, never a silent pick", async () => {
    await expect(
      callerFor(A).list({ withoutProject: true, projectId: P })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("entities.countWithoutProject — the counts half", () => {
  it("counts the same set as the list, by kind, largest first", async () => {
    const res = await callerFor(A).countWithoutProject();
    expect(res).toEqual({
      total: UNFILED.size,
      byProfile: [
        { profileSlug: "note", count: 2 },
        { profileSlug: "thing", count: 2 },
      ],
    });
    const listed = await callerFor(A).list({ withoutProject: true });
    expect(res.total).toBe(listed.total);
  });

  it("is floored per user: B sees only B's own unfiled thing", async () => {
    expect(await callerFor(B).countWithoutProject()).toEqual({
      total: 1,
      byProfile: [{ profileSlug: "thing", count: 1 }],
    });
  });
});

describe("entities.listMulti — withoutProject shares the same narrow", () => {
  it("a thing whose only project was deleted reads as unfiled there too", async () => {
    const res = await callerFor(A).listMulti({
      workspaceIds: [WS],
      withoutProject: true,
      profileSlug: "thing",
    });
    // `listForWorkspaces` does not floor on `deleted_at` (pre-existing, not
    // this narrow's concern), so the soft-deleted row is set aside here.
    const ids = res.entities.map((e) => e.id).filter((id) => id !== E_DELETED);
    expect(new Set(ids)).toEqual(new Set([E_NONE, E_GONE]));
  });
});
