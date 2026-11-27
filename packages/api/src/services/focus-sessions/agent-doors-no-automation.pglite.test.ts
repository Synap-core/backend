/**
 * The agent session doors leave out what an AUTOMATION opened unless asked
 * (decision 90897bca, founder, 27 Nov 2026: "AIs that check the latest
 * sessions get no automation sessions until they ask for automations").
 *
 * The four agent doors, each REAL, on PGlite, on one set of rows:
 *   - MCP `synap_list_sessions` and `synap_get_work_graph` (the handlers);
 *   - Hub REST `GET /focus-sessions` and `GET /focus-sessions/graph` (the
 *     routes, through a Hono app that sets the caller).
 * No `kind` named = every kind EXCEPT the sessions an automation opened
 * (`notAutomationSessionWhere`). A kind named (`all`, `run`), an
 * `automationId` or a subject brings them back.
 *
 * Each fixture row rules a candidate rule OUT:
 *   - `agentPlaybook`: a session an agent STARTED on a playbook (origin
 *     `playbook`, a `playbookId`; it reads `run`). A `kind: "work"` default
 *     hides it: that is how every lane of a wave would vanish.
 *   - `receipt`: an agent-write container. A `work` default hides it too.
 *   - `autoOpen`: an OPEN automation run. The 26 Nov graph default (closed
 *     automation runs only) keeps it.
 *   - `autoKeyOnly`: NULL origin, only `metadata.automationId`. A rule on
 *     `origin` alone keeps it.
 *   - `autoPlaybook`: an automation-launched playbook run (origin `playbook` +
 *     `automationRunId`). A rule on `origin = 'automation'` alone keeps it.
 *   - `nullOrigin`: a person's closed session with a NULL origin. A rule
 *     without `coalesce` drops it (`NOT (NULL = …)` is NULL).
 *
 * Cannot see: production Postgres and its plans (the index the default reads
 * through is pinned in `session-kind.not-automation-index.pglite.test.ts`),
 * the tRPC doors (a person's surface: they keep their `work` default).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    // The lineage read lives inside @synap/database and imports `db` from its
    // client module: route it onto the same PGlite (as work-graph.pglite.test).
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import type { McpToolContext } from "../../routers/mcp/handlers/shared.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const { sessionHandlers } =
  await import("../../routers/mcp/handlers/session.js");
const { registerFocusSessionsRoutes } =
  await import("../../routers/hub-protocol/rest/focus-sessions.js");

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  const sch = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${sch}"${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-agent-doors";
/** The automation DEFINITION two of the automation rows belong to. */
const AUTO_DEF = randomUUID();

const S = {
  work: randomUUID(),
  agentPlaybook: randomUUID(),
  receipt: randomUUID(),
  nullOrigin: randomUUID(),
  autoClosed: randomUUID(),
  autoKeyOnly: randomUUID(),
  autoOpen: randomUUID(),
  autoPlaybook: randomUUID(),
};
const NOT_AUTOMATION = [S.work, S.agentPlaybook, S.receipt, S.nullOrigin];
const AUTOMATION = [S.autoClosed, S.autoKeyOnly, S.autoOpen, S.autoPlaybook];

async function session(
  id: string,
  status: string,
  o: {
    origin?: string | null;
    playbookId?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, playbook_id, metadata, expected_outputs, criteria, stages, agent_ids, started_at, created_at, updated_at, closed_at)
     values ($1, $2, 'T', 'the goal', $3, $4, $5, $6::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}',
             now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour',
             case when $3 = 'active' then null else now() - interval '1 hour' end)`,
    [
      id,
      USER,
      status,
      o.origin ?? null,
      o.playbookId ?? null,
      JSON.stringify(o.metadata ?? {}),
    ]
  );
}

beforeAll(async () => {
  const tables = Object.values(schema as Record<string, unknown>).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  // Non-vacuity: the schema walk saw the tables these reads join.
  expect(tables.map((t) => getTableConfig(t).name)).toEqual(
    expect.arrayContaining(["focus_sessions", "links", "proposals"])
  );
  for (const t of tables) {
    const cfg = getTableConfig(t);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t));
  }
  await session(S.work, "active", { origin: "human" });
  await session(S.agentPlaybook, "active", {
    origin: "playbook",
    playbookId: randomUUID(),
    metadata: { clientKey: "conversation-1" },
  });
  await session(S.receipt, "active", {
    origin: "agent",
    metadata: { kind: "agent-proposal-package" },
  });
  await session(S.nullOrigin, "closed");
  await session(S.autoClosed, "closed", {
    origin: "automation",
    metadata: { automationRunId: randomUUID(), automationId: AUTO_DEF },
  });
  await session(S.autoKeyOnly, "closed", {
    metadata: { automationId: AUTO_DEF },
  });
  await session(S.autoOpen, "active", {
    origin: "automation",
    metadata: { automationRunId: randomUUID() },
  });
  await session(S.autoPlaybook, "closed", {
    origin: "playbook",
    playbookId: randomUUID(),
    metadata: { automationRunId: randomUUID() },
  });
}, 60_000);

// ── The doors ──────────────────────────────────────────────────────────────

async function mcp(
  tool: "synap_list_sessions" | "synap_get_work_graph",
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = (await sessionHandlers[tool]!({
    toolName: tool,
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read"],
  } as unknown as McpToolContext)) as { content: Array<{ text?: string }> };
  const body = JSON.parse(res.content[0]!.text!) as Record<string, unknown>;
  if (body.error) throw new Error(String(body.error));
  return body;
}

const mcpList = async (args: Record<string, unknown>) =>
  new Set(
    (
      (await mcp("synap_list_sessions", { limit: 50, ...args }))
        .sessions as Array<{
        id: string;
      }>
    ).map((s) => s.id)
  );

const mcpGraph = async (args: Record<string, unknown>) =>
  new Set(
    (
      (await mcp("synap_get_work_graph", args)).nodes as Array<{
        id: string;
      }>
    ).map((n) => n.id)
  );

function hubApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

async function hubGet(path: string): Promise<unknown> {
  const res = await hubApp().request(path);
  const body = (await res.json()) as unknown;
  if (res.status !== 200)
    throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const hubList = async (query: string) =>
  new Set(
    (
      (await hubGet(`/focus-sessions?status=all&limit=50${query}`)) as Array<{
        id: string;
      }>
    ).map((s) => s.id)
  );

const hubGraph = async (query: string) =>
  new Set(
    (
      (await hubGet(`/focus-sessions/graph?windowHours=72${query}`)) as {
        nodes: Array<{ id: string }>;
      }
    ).nodes.map((n) => n.id)
  );

const set = (ids: string[]) => new Set(ids);

// ── What they answer ───────────────────────────────────────────────────────

describe("no kind named: every kind except what an automation opened", () => {
  it("MCP synap_list_sessions (status all), and its own open default", async () => {
    expect(await mcpList({ status: "all" })).toEqual(set(NOT_AUTOMATION));
    // The door's own `open` default: the open automation run stays out too.
    expect(await mcpList({})).toEqual(
      set([S.work, S.agentPlaybook, S.receipt])
    );
  });

  it("Hub REST GET /focus-sessions", async () => {
    expect(await hubList("")).toEqual(set(NOT_AUTOMATION));
  });

  it("MCP synap_get_work_graph", async () => {
    expect(await mcpGraph({})).toEqual(set(NOT_AUTOMATION));
  });

  it("Hub REST GET /focus-sessions/graph", async () => {
    expect(await hubGraph("")).toEqual(set(NOT_AUTOMATION));
  });
});

describe("asking for them brings them back", () => {
  it("`kind: all` — every door", async () => {
    const every = set([...NOT_AUTOMATION, ...AUTOMATION]);
    expect(await mcpList({ status: "all", kind: "all" })).toEqual(every);
    expect(await hubList("&kind=all")).toEqual(every);
    expect(await mcpGraph({ kind: "all" })).toEqual(every);
    expect(await hubGraph("&kind=all")).toEqual(every);
  });

  it("`kind: run` — the automation runs beside the agent's playbook session", async () => {
    const runs = set([S.agentPlaybook, ...AUTOMATION]);
    expect(await mcpList({ status: "all", kind: "run" })).toEqual(runs);
    expect(await hubList("&kind=run")).toEqual(runs);
    expect(await mcpGraph({ kind: "run" })).toEqual(runs);
    expect(await hubGraph("&kind=run")).toEqual(runs);
  });

  it("an `automationId` with no kind: that automation's sessions", async () => {
    const ofDef = set([S.autoClosed, S.autoKeyOnly]);
    expect(await mcpList({ status: "all", automationId: AUTO_DEF })).toEqual(
      ofDef
    );
    expect(await hubList(`&automationId=${AUTO_DEF}`)).toEqual(ofDef);
  });
});
