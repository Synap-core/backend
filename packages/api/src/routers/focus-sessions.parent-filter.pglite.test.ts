/**
 * `focusSessions.browse` — the `parentSessionId` filter (the "Show all" behind
 * the continuation packet's `children` section), on PGlite through the REAL
 * router: the WHERE is `sessionListConditions`, real SQL, not a post-filter.
 *
 * Fixture:
 *   PARENT     USER's work session
 *   C_WORK     USER's work child      (C_WORK  --spawned_from--> PARENT)
 *   C_RUN      USER's closed RUN child (C_RUN   --spawned_from--> PARENT)
 *   GRAND      USER's grandchild      (GRAND   --spawned_from--> C_WORK)
 *   C_FOREIGN  OTHER user's child     (C_FOREIGN --spawned_from--> PARENT)
 *   LONE       USER's session with no parent
 *
 * What it rules out: a filter that returns the whole wave (GRAND), one that
 * ignores the owner floor (C_FOREIGN), one that reads the edge backwards
 * (PARENT itself would list), and no filter at all (LONE).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    getParentSessionIds: async () => new Map<string, string>(),
    getParentSessionId: async () => null,
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessionsRouter } from "./focus-sessions.js";

const USER = "user-1";
const OTHER = "user-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const ago = (mins: number) =>
  new Date(Date.now() - mins * 60_000).toISOString();

const W1 = randomUUID();
const PARENT = randomUUID();
const C_WORK = randomUUID();
const C_RUN = randomUUID();
const GRAND = randomUUID();
const C_FOREIGN = randomUUID();
const LONE = randomUUID();

async function session(
  id: string,
  o: {
    user: string;
    goal: string;
    run?: boolean;
    status?: string;
    mins: number;
  }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, playbook_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'[]'::jsonb,'{}'::jsonb,$7,$8,$8,$8)`,
    [
      id,
      o.user,
      W1,
      o.run ? randomUUID() : null,
      o.goal,
      o.status ?? "active",
      o.run ? "playbook" : "human",
      ago(o.mins),
    ]
  );
}

async function spawnedFrom(child: string, parent: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1,'session',$2,'session',$3,'spawned_from','{}'::jsonb, now())`,
    [randomUUID(), child, parent]
  );
}

const caller = (activeWorkspaceId?: string) =>
  focusSessionsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
    ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
  } as never);
const setOf = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
/** The population the packet's `children.total` counts. */
const EVERY = { kind: "all", lens: "all", status: "all" } as const;

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(`insert into workspaces (id, name) values ($1,'Builder')`, [W1]);
  for (const u of [USER, OTHER]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
      [randomUUID(), W1, u]
    );
    await q(
      `insert into users (id, name, email, user_type) values ($1,$1,$2,'human')`,
      [u, `${u}@x.io`]
    );
  }
  await session(PARENT, { user: USER, goal: "Ship the wave", mins: 20 });
  await session(C_WORK, { user: USER, goal: "Lane A", mins: 15 });
  await session(C_RUN, {
    user: USER,
    goal: "Weekly digest",
    run: true,
    status: "closed",
    mins: 14,
  });
  await session(GRAND, { user: USER, goal: "Lane A detour", mins: 10 });
  await session(C_FOREIGN, { user: OTHER, goal: "Their lane", mins: 9 });
  await session(LONE, { user: USER, goal: "Unrelated", mins: 5 });
  await spawnedFrom(C_WORK, PARENT);
  await spawnedFrom(C_RUN, PARENT);
  await spawnedFrom(GRAND, C_WORK);
  await spawnedFrom(C_FOREIGN, PARENT);
});

describe("focusSessions.browse — parentSessionId", () => {
  it("lists exactly the reader's direct children, every kind and status", async () => {
    const page = await caller().browse({ parentSessionId: PARENT, ...EVERY });
    expect(setOf(page.items)).toEqual(new Set([C_WORK, C_RUN]));
  });

  it("follows one level only: a child's own children are its page, not the parent's", async () => {
    const page = await caller().browse({ parentSessionId: C_WORK, ...EVERY });
    expect(setOf(page.items)).toEqual(new Set([GRAND]));
  });

  it("composes with the default lenses (work, open) as a narrowing", async () => {
    const page = await caller().browse({ parentSessionId: PARENT });
    expect(setOf(page.items)).toEqual(new Set([C_WORK]));
  });

  it("an ambient active-space header does not hide children filed elsewhere", async () => {
    // The packet's `children.total` counts every space; "Show all" must too.
    const page = await caller(randomUUID()).browse({
      parentSessionId: PARENT,
      ...EVERY,
    });
    expect(setOf(page.items)).toEqual(new Set([C_WORK, C_RUN]));
    // Non-vacuity: the same header DOES narrow an ordinary browse.
    const plain = await caller(randomUUID()).browse({ ...EVERY });
    expect(plain.items).toHaveLength(0);
  });

  it("an explicit workspaceId still narrows", async () => {
    const page = await caller().browse({
      parentSessionId: PARENT,
      workspaceId: randomUUID(),
      ...EVERY,
    });
    expect(page.items).toHaveLength(0);
  });

  it("a session with no children lists nothing", async () => {
    const page = await caller().browse({ parentSessionId: LONE, ...EVERY });
    expect(page.items).toHaveLength(0);
  });

  it("non-vacuity: without the filter the other sessions are there", async () => {
    const page = await caller().browse({ ...EVERY, limit: 100 });
    expect(setOf(page.items)).toEqual(
      new Set([PARENT, C_WORK, C_RUN, GRAND, LONE])
    );
  });
});
