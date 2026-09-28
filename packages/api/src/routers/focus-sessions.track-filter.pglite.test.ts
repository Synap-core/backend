/**
 * `focusSessions.list` / `browse` — the `trackId` filter and `browse`'s
 * `includeTrackedRuns`, on PGlite through the REAL router (both go through
 * `sessionListConditions`, so the WHERE is real SQL, not a post-filter).
 *
 * Fixture (all USER's, one project):
 *   W_T1   work session filed in track T1
 *   R_T1   RUN session (playbook-minted) filed in T1 — "Weekly digest"
 *   W_T2   work session filed in track T2
 *   R_OFF  untracked RUN session — "Weekly digest" too, never on the path
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
const PROJ = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const W_T1 = randomUUID();
const R_T1 = randomUUID();
const W_T2 = randomUUID();
const R_OFF = randomUUID();

async function session(
  id: string,
  o: { goal: string; track: string | null; run: boolean; mins: number }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, playbook_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,'active','[]'::jsonb,'{}'::jsonb,$8,$9,$9,$9)`,
    [
      id,
      USER,
      W1,
      PROJ,
      o.track,
      o.run ? randomUUID() : null,
      o.goal,
      o.run ? "playbook" : "human",
      ago(o.mins),
    ]
  );
}

const caller = () =>
  focusSessionsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);
const setOf = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(`insert into workspaces (id, name) values ($1,'Builder')`, [W1]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), W1, USER]
  );
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Antoine','a@x.io','human')`,
    [USER]
  );
  await session(W_T1, {
    goal: "Outline the launch",
    track: T1,
    run: false,
    mins: 10,
  });
  await session(R_T1, { goal: "Weekly digest", track: T1, run: true, mins: 9 });
  await session(W_T2, { goal: "Pricing page", track: T2, run: false, mins: 8 });
  await session(R_OFF, {
    goal: "Weekly digest",
    track: null,
    run: true,
    mins: 7,
  });
});

describe("focusSessions.list — trackId", () => {
  it("narrows to the track, and with tracked runs includes its run sessions", async () => {
    const withRuns = await caller().list({
      trackId: T1,
      includeTrackedRuns: true,
      limit: 50,
    });
    expect(setOf(withRuns)).toEqual(new Set([W_T1, R_T1]));
    const workOnly = await caller().list({ trackId: T1, limit: 50 });
    expect(setOf(workOnly)).toEqual(new Set([W_T1]));
    // Non-vacuity: without the filter both tracks' work shows.
    expect(setOf(await caller().list({ limit: 50 }))).toEqual(
      new Set([W_T1, W_T2])
    );
  });
});

describe("focusSessions.browse — trackId + includeTrackedRuns", () => {
  it("search finds a tracked run only with includeTrackedRuns, never an untracked one", async () => {
    const found = await caller().browse({
      q: "digest",
      includeTrackedRuns: true,
    });
    expect(setOf(found.items)).toEqual(new Set([R_T1]));
    const plain = await caller().browse({ q: "digest" });
    expect(plain.items).toHaveLength(0);
  });

  it("narrows to one track", async () => {
    const t2 = await caller().browse({ trackId: T2 });
    expect(setOf(t2.items)).toEqual(new Set([W_T2]));
    const t1 = await caller().browse({ trackId: T1, includeTrackedRuns: true });
    expect(setOf(t1.items)).toEqual(new Set([W_T1, R_T1]));
  });

  it("refuses includeTrackedRuns with another kind, like list", async () => {
    await expect(
      caller().browse({ includeTrackedRuns: true, kind: "run" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
