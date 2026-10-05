/**
 * `focusSessions.browse` `liveness: true` — the D1 liveness facts (the same
 * batched read `list` attaches), bounded to the working window, on PGlite
 * through the REAL router.
 *
 * Fixture (all USER's, each with its own room):
 *   RUNNING  a chat turn in flight (older than the window — never bounded)
 *   RECENT   a finished turn 2 min ago (inside the window)
 *   QUIET    a finished turn 60 min ago (outside the window)
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
const RUNNING = randomUUID();
const RECENT = randomUUID();
const QUIET = randomUUID();

async function session(id: string, turn: { status: string; mins: number }) {
  const channel = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, channel_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at)
     values ($1,$2,$3,$4,$5,'active','[]'::jsonb,'{}'::jsonb,'human',$6,$6,$6)`,
    [id, USER, W1, channel, `goal ${id}`, ago(120)]
  );
  await q(
    `insert into chat_turns (id, channel_id, status, started_at, updated_at)
     values ($1,$2,$3,$4,$4)`,
    [randomUUID(), channel, turn.status, ago(turn.mins)]
  );
}

const caller = () =>
  focusSessionsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

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
  await session(RUNNING, { status: "running", mins: 30 });
  await session(RECENT, { status: "completed", mins: 2 });
  await session(QUIET, { status: "completed", mins: 60 });
});

describe("focusSessions.browse — liveness", () => {
  it("attaches live on every row only when asked, bounded to the working window", async () => {
    const page = await caller().browse({ liveness: true });
    const by = new Map(page.items.map((r) => [r.id, r.live]));
    expect(by.get(RUNNING)).toMatchObject({ turnInFlight: true });
    expect(by.get(RECENT)?.turnInFlight).toBe(false);
    expect(by.get(RECENT)?.lastAt).toBeTruthy();
    // Bounded: activity older than the window is not read (lastAt null, not a
    // 60-minute-old timestamp) — and it is a MEASURED quiet row, not a failed one.
    expect(by.get(QUIET)).toMatchObject({ turnInFlight: false, lastAt: null });
  });

  it("omits live when not requested", async () => {
    const page = await caller().browse({});
    expect(page.items.length).toBe(3);
    for (const r of page.items) expect(r).not.toHaveProperty("live");
  });
});
