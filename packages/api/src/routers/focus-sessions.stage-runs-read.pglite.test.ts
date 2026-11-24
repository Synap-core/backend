/**
 * WHO WORKS EACH STEP ARRIVES ON THE SESSION READ (runner engine slice 3):
 * `continuation.stageRuns`, read from `session_stage_runs`, through the REAL
 * doors on PGlite: tRPC `focusSessions.get`, MCP `synap_get_session` (full and
 * lean) and Hub `GET /focus-sessions/:id` (full and `?detail=lean`).
 *
 * Asserted (each rules out a rule the others would pass):
 *   - the entries of THIS session only, oldest first, each with the agent and
 *     the computer named (Synap AI = `agent: null`), the child session and
 *     both times; the four doors carry the same section;
 *   - bounded: past PACKET_STAGE_RUNS_MAX entries, `total` counts all and the
 *     newest are kept, still oldest first;
 *   - the visibility floor: another person's session is not read at all, and a
 *     key pinned to spaces (a pod app) gets the row with the packet withheld,
 *     so no step entries.
 * Stubbed: lineage (`getParentSessionId(s)`, its own connection: no parent).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    getParentSessionId: async () => null,
    getParentSessionIds: async () => new Map(),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db, runWithGrant } from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";
import { sessionHandlers } from "./mcp/handlers/session.js";
import { allSchemaTables } from "../__tests__/pglite-ddl.js";
import { PACKET_STAGE_RUNS_MAX } from "../services/focus-sessions/continuation-packet.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";

const { registerFocusSessionsRoutes } =
  await import("./hub-protocol/rest/focus-sessions.js");

const USER = randomUUID();
const OTHER = randomUUID();
const HERMES = randomUUID();
const DEVBOX = randomUUID();
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(userId = USER): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, expected_outputs, metadata, current_stage, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Edit the video', 'Edit the video', 'active', '[]'::jsonb, '{}'::jsonb, 'mix', now(), now(), now())`,
    [id, userId, WS]
  );
  return id;
}

/** One step entry, `minutesAgo` minutes old. */
async function entry(
  sessionId: string,
  stageKey: string,
  minutesAgo: number,
  extra: {
    status?: string;
    agent?: string | null;
    computer?: string | null;
    child?: string | null;
    ended?: boolean;
  } = {}
): Promise<void> {
  await q(
    `insert into session_stage_runs (id, session_id, stage_key, attempt, runner_agent_user_id, runner_via, computer_user_id, child_session_id, status, started_at, ended_at)
     values ($1, $2, $3, 1, $4, 'stage', $5, $6, $7, now() - ($8::int * interval '1 minute'), case when $9 then now() - (($8::int - 1) * interval '1 minute') else null end)`,
    [
      randomUUID(),
      sessionId,
      stageKey,
      extra.agent ?? null,
      extra.computer ?? null,
      extra.child ?? null,
      extra.status ?? "running",
      minutesAgo,
      extra.ended === true,
    ]
  );
}

type StageRuns = {
  status: string;
  total: number;
  items: Array<Record<string, unknown>>;
};

const trpcGet = async (id: string) =>
  (
    (await focusSessionsRouter
      .createCaller({ db, authenticated: true, userId: USER } as never)
      .get({ id })) as unknown as { continuation: { stageRuns: StageRuns } }
  ).continuation.stageRuns;

async function mcpGet(
  id: string,
  detail?: "lean"
): Promise<Record<string, unknown>> {
  const res = await sessionHandlers.synap_get_session!({
    toolName: "synap_get_session",
    args: { sessionId: id, ...(detail ? { detail } : {}) },
    userId: USER,
    apiKeyScopes: ["mcp.read"],
    workspaceAccessible: false,
    caller: null as never,
    lensCaller: null as never,
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

function hubGet(id: string, query = "", grant?: unknown) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  const send = () => app.request(`/focus-sessions/${id}${query}`);
  return grant ? runWithGrant(grant as never, () => send()) : send();
}

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create schema if not exists pgboss; create table if not exists pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);`
  );
  await q(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'o@x.test', 'Other', 'human'),
      ($3, 'h@x.test', 'Hermes', 'agent'),
      ($4, 'd@x.test', 'devbox', 'agent')`,
    [USER, OTHER, HERMES, DEVBOX]
  );
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from session_stage_runs;"
  );
});

describe("continuation.stageRuns on the session read", () => {
  it("this session's entries, oldest first, named, the same on every door", async () => {
    const id = await session();
    const child = randomUUID();
    await entry(id, "cut", 30, { status: "done", ended: true });
    await entry(id, "render", 20, {
      status: "done",
      child,
      ended: true,
    });
    await entry(id, "mix", 10, { agent: HERMES, computer: DEVBOX });
    // Another session's entry never shows here.
    await entry(await session(), "cut", 5, { agent: HERMES });

    const runs = await trpcGet(id);
    expect(runs.status).toBe("ok");
    expect(runs.total).toBe(3);
    expect(runs.items.map((r) => r.stageKey)).toEqual(["cut", "render", "mix"]);
    expect(runs.items[0]).toMatchObject({
      stageKey: "cut",
      status: "done",
      agent: null,
      computer: null,
      childSessionId: null,
      attempt: 1,
    });
    expect(typeof runs.items[0]!.endedAt).toBe("string");
    expect(runs.items[1]).toMatchObject({ childSessionId: child });
    expect(runs.items[2]).toMatchObject({
      stageKey: "mix",
      status: "running",
      agent: { id: HERMES, name: "Hermes" },
      computer: { id: DEVBOX, name: "devbox" },
      endedAt: null,
    });
    expect(typeof runs.items[2]!.startedAt).toBe("string");

    const full = (await mcpGet(id)) as {
      continuation: { stageRuns: StageRuns };
    };
    expect(full.continuation.stageRuns).toEqual(runs);
    const lean = (await mcpGet(id, "lean")) as {
      continuation: { stageRuns: StageRuns };
    };
    expect(lean.continuation.stageRuns).toEqual(runs);

    const hubFull = (await (await hubGet(id)).json()) as {
      continuation: { stageRuns: StageRuns };
    };
    expect(hubFull.continuation.stageRuns).toEqual(runs);
    const hubLean = (await (await hubGet(id, "?detail=lean")).json()) as {
      continuation: { stageRuns: StageRuns };
    };
    expect(hubLean.continuation.stageRuns).toEqual(runs);
  });

  it("bounded: total counts every entry, the newest are kept, oldest first", async () => {
    const id = await session();
    const n = PACKET_STAGE_RUNS_MAX + 5;
    for (let i = 0; i < n; i++) {
      await entry(id, `s${i}`, n - i, { status: "done", ended: true });
    }
    const runs = await trpcGet(id);
    expect(runs.total).toBe(n);
    expect(runs.items).toHaveLength(PACKET_STAGE_RUNS_MAX);
    expect(runs.items[0]!.stageKey).toBe("s5");
    expect(runs.items.at(-1)!.stageKey).toBe(`s${n - 1}`);
  });

  it("the floor: another person's session is not read, a pinned app gets no packet", async () => {
    const theirs = await session(OTHER);
    await entry(theirs, "mix", 10, { agent: HERMES });
    await expect(trpcGet(theirs)).rejects.toThrow();
    expect((await hubGet(theirs)).status).toBe(404);

    const mine = await session();
    await entry(mine, "mix", 10, { agent: HERMES });
    const pinned = await hubGet(mine, "", {
      scopes: [{ permissions: ["session.read"], workspaceIds: [WS] }],
      clientId: null,
    });
    expect(pinned.status).toBe(200);
    const body = (await pinned.json()) as Record<string, unknown>;
    expect(body.continuation).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(HERMES);
  });
});
