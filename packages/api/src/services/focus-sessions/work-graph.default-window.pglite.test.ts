/**
 * The work graph's DEFAULT window and the apps' node, on PGlite: the REAL
 * `buildWorkGraph` (the list's ONE WHERE, the real attach helpers) and the
 * REAL tRPC door (`focusSessions.graph`).
 *
 * 1. No `kind` named = every kind but the sessions an AUTOMATION opened
 *    (decision 90897bca, 27 Nov 2026: agents get no automation sessions until
 *    they ask; it replaced the 26 Nov default, CLOSED automation runs only,
 *    set when one automation closed ~3,700 runs in 72 h and buried the map's
 *    ~400 other sessions under its 500 ceiling). Fixture rows sit where the
 *    candidate rules disagree:
 *      - a closed run marked only by `metadata.automationId` (NULL origin): a
 *        rule reading `origin` alone keeps it;
 *      - a closed PERSON's session with a NULL origin: `NOT (origin IN …)`
 *        is NULL there, so a rule without `coalesce` drops it;
 *      - a closed playbook run: a rule dropping every `run` drops it;
 *      - open and failed automation runs: the 26 Nov rule (closed only)
 *        keeps them;
 *      - a closed automation run a person ACCEPTED from triage (`work`: a
 *        person took it on): a rule on origin or keys alone drops it;
 *      - a closed automation run at the far end of an open session's edge:
 *        a rule applied to the far ends loses the edge.
 *    `kind: "all"` and `kind: "run"` named explicitly keep the automation
 *    sessions. (Every agent door on the same rule: agent-doors-no-automation.)
 * 2. The tRPC door sends each node with the app fields only
 *    (`WORK_GRAPH_APP_NODE_FIELDS`), equal to the full node's, and none of
 *    the heavy row fields the service node carries.
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
import * as schema from "@synap/database/schema";
import { buildWorkGraph, WORK_GRAPH_APP_NODE_FIELDS } from "./work-graph.js";
import { focusSessionsRouter } from "../../routers/focus-sessions.js";

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

const USER = "user-runs";
const S = {
  workOpen: randomUUID(), // a person's open session, heavy row fields set
  workClosed: randomUUID(), // a person's session closed 1 h ago, NULL origin
  autoClosed: randomUUID(), // origin automation + automationRunId, closed
  autoKeyOnly: randomUUID(), // NULL origin, metadata.automationId only, closed
  autoOpen: randomUUID(), // origin automation, active
  autoFailed: randomUUID(), // origin automation, failed
  playbookClosed: randomUUID(), // a playbook run, closed
  autoAccepted: randomUUID(), // automation run a person accepted (work), closed
  autoFarEnd: randomUUID(), // closed automation run workOpen is blocked by
};

async function session(
  id: string,
  status: string,
  o: {
    origin?: string | null;
    playbookId?: string | null;
    metadata?: Record<string, unknown>;
    heavy?: boolean;
  } = {}
) {
  const closed = status === "active" ? null : 1;
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, playbook_id, metadata, expected_outputs, criteria, stages, agent_ids, started_at, created_at, updated_at, closed_at)
     values ($1, $2, 'T', 'the goal', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, '{}',
             now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour',
             case when $10::int is null then null else now() - interval '1 hour' end)`,
    [
      id,
      USER,
      status,
      o.origin ?? null,
      o.playbookId ?? null,
      JSON.stringify(o.metadata ?? {}),
      JSON.stringify(
        o.heavy ? [{ key: "pr", label: "Pull request", kind: "code" }] : []
      ),
      JSON.stringify(
        o.heavy
          ? [{ key: "c1", statement: "It works", check: { kind: "human" } }]
          : []
      ),
      JSON.stringify(o.heavy ? [{ key: "build", name: "Build" }] : []),
      closed,
    ]
  );
}

const graph = (kind?: "all" | "run") =>
  buildWorkGraph({
    userId: USER,
    scope: { workspaceLens: undefined, projectLens: undefined },
    windowHours: 72,
    ...(kind ? { kind } : {}),
    lens: "all",
    roster: false,
  });

const ids = (
  nodes: Array<{ id: string; inWindow: boolean }>,
  inWindow: boolean
) => new Set(nodes.filter((n) => n.inWindow === inWindow).map((n) => n.id));

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  // Non-vacuity: the schema walk saw the tables this read joins.
  expect(tables.map((t) => getTableConfig(t).name)).toEqual(
    expect.arrayContaining(["focus_sessions", "links", "proposals"])
  );
  for (const t of tables) {
    const cfg = getTableConfig(t);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t));
  }
  await session(S.workOpen, "active", {
    origin: "human",
    metadata: { note: "x".repeat(200) },
    heavy: true,
  });
  await session(S.workClosed, "closed");
  await session(S.autoClosed, "closed", {
    origin: "automation",
    metadata: { automationRunId: randomUUID(), automationId: randomUUID() },
  });
  await session(S.autoKeyOnly, "closed", {
    metadata: { automationId: randomUUID() },
  });
  await session(S.autoOpen, "active", {
    origin: "automation",
    metadata: { automationRunId: randomUUID() },
  });
  await session(S.autoFailed, "failed", {
    origin: "automation",
    metadata: { automationRunId: randomUUID() },
  });
  await session(S.playbookClosed, "closed", {
    origin: "playbook",
    playbookId: randomUUID(),
  });
  await session(S.autoAccepted, "closed", {
    origin: "automation",
    metadata: {
      automationRunId: randomUUID(),
      triage: { acceptedAt: new Date().toISOString() },
    },
  });
  await session(S.autoFarEnd, "closed", {
    origin: "automation",
    metadata: { automationRunId: randomUUID() },
  });
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, 'blocked_by', '{}'::jsonb, now())`,
    [randomUUID(), S.workOpen, S.autoFarEnd]
  );
}, 60_000);

describe("buildWorkGraph — the default window leaves out what an automation opened", () => {
  it("no kind named: every other session stays, the automation sessions do not", async () => {
    const g = await graph();
    expect(ids(g.nodes, true)).toEqual(
      new Set([S.workOpen, S.workClosed, S.playbookClosed, S.autoAccepted])
    );
    for (const id of [S.autoClosed, S.autoKeyOnly, S.autoOpen, S.autoFailed])
      expect(ids(g.nodes, true)).not.toContain(id);
    // Not counted as cut: the default window does not hold them.
    expect(g.window.truncated).toBe(false);
    expect(g.window.omitted).toBe(0);
  });

  it("a closed automation run at the far end of an edge still comes back, and the edge is drawn", async () => {
    const g = await graph();
    expect(ids(g.nodes, false)).toEqual(new Set([S.autoFarEnd]));
    expect(g.edges).toContainEqual({
      kind: "blocked_by",
      from: S.workOpen,
      to: S.autoFarEnd,
    });
  });

  it("`kind: all` named explicitly keeps them", async () => {
    const g = await graph("all");
    expect(ids(g.nodes, true)).toEqual(new Set(Object.values(S)));
  });

  it("`kind: run` named explicitly keeps them", async () => {
    const g = await graph("run");
    const window = ids(g.nodes, true);
    for (const id of [S.autoClosed, S.autoKeyOnly, S.autoFarEnd, S.autoOpen])
      expect(window).toContain(id);
    expect(window).not.toContain(S.workOpen);
  });
});

describe("focusSessions.graph (tRPC) — the apps' node", () => {
  const caller = () =>
    focusSessionsRouter.createCaller({
      db: null,
      authenticated: true,
      userId: USER,
    } as never);

  it("sends each node with the app fields only, equal to the full node's", async () => {
    const full = await graph("all");
    const wire = await caller().graph({ kind: "all", lens: "all" });
    expect(wire.nodes.map((n) => n.id).sort()).toEqual(
      full.nodes.map((n) => n.id).sort()
    );
    const kept = new Set<string>(WORK_GRAPH_APP_NODE_FIELDS);
    const fullOf = new Map(full.nodes.map((n) => [n.id, n]));
    for (const node of wire.nodes) {
      const f = fullOf.get(node.id)! as unknown as Record<string, unknown>;
      for (const key of Object.keys(node)) expect(kept).toContain(key);
      for (const key of kept) {
        if (key in f)
          expect((node as unknown as Record<string, unknown>)[key]).toEqual(
            f[key]
          );
      }
    }
    // The fields the apps' graph model reads (`WorkGraphNodeInput`) arrive.
    const open = wire.nodes.find(
      (n) => n.id === S.workOpen
    )! as unknown as Record<string, unknown>;
    for (const key of [
      "id",
      "title",
      "goal",
      "status",
      "trackId",
      "projectId",
      "parentSessionId",
      "startedAt",
      "updatedAt",
      "closedAt",
      "progress",
      "nextMove",
      "unitFacts",
      "live",
      "holder",
      "inWindow",
    ])
      expect(open).toHaveProperty(key);
    expect(open.goal).toBe("the goal");
    // The heavy row fields stay on the pod — and the full node HAD them.
    const fullOpen = fullOf.get(S.workOpen)! as unknown as Record<
      string,
      unknown
    >;
    for (const key of ["expectedOutputs", "metadata", "stages", "criteria"]) {
      expect(fullOpen[key]).toBeTruthy();
      expect(open).not.toHaveProperty(key);
    }
    // Everything else on the read is forwarded as built.
    expect(wire.edges).toEqual(full.edges);
    expect(wire.window).toEqual({ ...full.window, since: wire.window.since });
  });
});
