/**
 * `focusSessions.list` `runners: true` through the REAL router on PGlite: each
 * session's runners (`session_runners`) joined to the terminal each runs in
 * (`agent_conversations`, 0354) — the VALUES arrive at the door.
 *   - absent without the flag (no shape change for existing callers);
 *   - a runner of a terminal the viewer reports carries its computer, folder,
 *     state and sub-agents; a runner with no reported terminal has `null`;
 *   - a FAILED read is `{status: "unavailable"}`, never an empty list.
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
const S = randomUUID();
const OTHER = randomUUID();
const KEY = randomUUID();

const caller = () =>
  focusSessionsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

type Row = Awaited<ReturnType<ReturnType<typeof caller>["list"]>>[number];
const rowOf = (rows: Row[], id: string) => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(`insert into workspaces (id, name) values ($1,'Builder')`, [W1]);
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Antoine','a@x.io','human')`,
    [USER]
  );
  for (const [id, mins] of [
    [S, 5],
    [OTHER, 4],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at)
       values ($1,$2,$3,'Ship presence','active','[]'::jsonb,'{}'::jsonb,'human',$4,$4,$4)`,
      [id, USER, W1, ago(mins)]
    );
  }
  const runner = (session: string, conv: string) =>
    q(
      `insert into session_runners (session_id, client_key, user_id, harness, conversation_id, first_seen_at, last_seen_at)
       values ($1, $2, $3, 'claude-code', $4, now(), now())`,
      [session, `key:${KEY}|conv:claude-code:${conv}`, USER, conv]
    );
  await runner(S, "conv-reported");
  await runner(S, "conv-silent");
  await q(
    `insert into agent_conversations (id, user_id, computer, harness, conversation_id, folder, state, state_since, subagent_count, first_seen_at, last_seen_at)
     values ($1, $2, 'devbox', 'claude-code', 'conv-reported', 'synap', 'waiting', now(), 2, now(), now())`,
    [randomUUID(), USER]
  );
});

describe("focusSessions.list — runners", () => {
  it("absent without the flag", async () => {
    const rows = await caller().list({ limit: 50 });
    expect(rowOf(rows, S).runners).toBeUndefined();
  });

  it("each runner joined to its terminal; a runner with no terminal reads null", async () => {
    const rows = await caller().list({ limit: 50, runners: true });
    const section = rowOf(rows, S).runners!;
    expect(section.status).toBe("ok");
    if (section.status !== "ok") return;
    const byConv = Object.fromEntries(
      section.items.map((i) => [i.conversationId, i] as const)
    );
    expect(Object.keys(byConv).sort()).toEqual([
      "conv-reported",
      "conv-silent",
    ]);
    expect(byConv["conv-reported"]).toMatchObject({
      harness: "claude-code",
      live: true,
      terminal: {
        computer: "devbox",
        folder: "synap",
        state: "waiting",
        subagents: 2,
        ended: false,
      },
    });
    expect(byConv["conv-silent"]!.terminal).toBeNull();
    // A session nobody is attached to: ok and empty — not unavailable.
    expect(rowOf(rows, OTHER).runners).toEqual({ status: "ok", items: [] });
  });

  it("a failed read is unavailable on every row, never an empty list", async () => {
    await h.client!.exec(
      `alter table agent_conversations rename to agent_conversations_gone`
    );
    try {
      const rows = await caller().list({ limit: 50, runners: true });
      for (const id of [S, OTHER]) {
        expect(rowOf(rows, id).runners).toMatchObject({
          status: "unavailable",
        });
      }
    } finally {
      await h.client!.exec(
        `alter table agent_conversations_gone rename to agent_conversations`
      );
    }
  });
});
