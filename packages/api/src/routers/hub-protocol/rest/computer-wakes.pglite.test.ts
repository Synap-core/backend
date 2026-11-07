/**
 * `GET /computers/me/wakes` — a computer's waker (plan v2 slice 4).
 *
 * Pinned: only a computer's own key reads it; every read stamps that key as
 * the waker (the wake lease) BEFORE the roster is read; the "Wakes agents"
 * switch off answers an empty list that says so; on, the list is exactly the
 * agents on THIS computer that the roster reads `can_wake` AND that have work
 * handed to them, and a handed read that failed is said, never dropped.
 *
 * The roster and the handed read are their own doors (tested where they live):
 * stubbed here, with what the route passes them recorded.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  roster: { agents: [] as unknown[], computers: [] as unknown[] },
  rosterCalls: [] as Array<{ userId: string; stampedFirst: boolean }>,
  handed: new Map<string, unknown>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../../../services/agent-dispatch/agents-for-handoff.js", () => ({
  readAgentsForHandoff: async (userId: string) => {
    const r = await h.client!.query<{ n: number }>(
      `select count(*)::int as n from api_keys where user_id = 'machine-1' and worker_served_at is not null`
    );
    h.rosterCalls.push({ userId, stampedFirst: r.rows[0]!.n > 0 });
    return h.roster;
  },
}));
vi.mock("../../../services/discover/start-here.js", () => ({
  readHandedToYou: async (_userId: string, agentUserId: string) =>
    h.handed.get(agentUserId) ?? {
      count: 0,
      countIsLowerBound: false,
      items: [],
    },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerComputerWakesRoutes } from "./computer-wakes.js";
import type { HubHono, HubVariables } from "./_shared.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const MACHINE = "machine-1";
const OTHER_MACHINE = "machine-2";
const KEY = "00000000-0000-4000-8000-000000000001";

function appAs(vars: {
  userId: string;
  agentUserId?: string;
  apiKeyId?: string;
}): HubHono {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    c.set("apiKeyId", vars.apiKeyId ?? KEY);
    await next();
  });
  registerComputerWakesRoutes(app);
  return app;
}

const get = (app: HubHono) =>
  app.request("/computers/me/wakes", {
    headers: { "x-synap-runner": "synap-waker/0.9.9" },
  });

const agentRow = (id: string, machine: string, state: string) => ({
  agentUserId: id,
  name: id,
  agentType: "claude-code",
  computer: { agentUserId: machine, name: "devbox", belongsTo: "person" },
  template: {
    slug: "claude-code",
    label: "Claude Code",
    version: null,
    wake: null,
  },
  wake: { state, how: "runner", why: state === "can_wake" ? null : "no_waker" },
});

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE users (id text PRIMARY KEY, name text, agent_type text,
      created_by_user_id text, agent_metadata jsonb);
    CREATE TABLE api_keys (id uuid PRIMARY KEY, user_id text NOT NULL,
      worker_served_at timestamptz, worker_served_version text);
  `);
  await q(
    `INSERT INTO users VALUES ($1, 'person', NULL, NULL, NULL), ($2, 'devbox', 'machine', $1, '{"wakesAgents": true}'), ($3, 'laptop', 'machine', $1, NULL), ('agent-x', 'Claude', 'claude-code', $1, NULL)`,
    [PERSON, MACHINE, OTHER_MACHINE]
  );
  await q(`INSERT INTO api_keys (id, user_id) VALUES ($1, $2)`, [KEY, MACHINE]);
}, 60_000);

beforeEach(() => {
  h.rosterCalls = [];
  h.handed = new Map();
});

describe("GET /computers/me/wakes", () => {
  it("only a computer's own key reads it", async () => {
    expect((await get(appAs({ userId: PERSON }))).status).toBe(403);
    expect(
      (await get(appAs({ userId: PERSON, agentUserId: "agent-x" }))).status
    ).toBe(403);
    expect(
      (await get(appAs({ userId: "someone-else", agentUserId: MACHINE })))
        .status
    ).toBe(403);
    expect(h.rosterCalls).toHaveLength(0);
  });

  it("stamps the lease first, then answers the can_wake agents of THIS computer that have handed work", async () => {
    h.roster = {
      agents: [
        agentRow("cc-here", MACHINE, "can_wake"),
        agentRow("idle-here", MACHINE, "can_wake"),
        agentRow("awake-here", MACHINE, "awake"),
        agentRow("cc-elsewhere", OTHER_MACHINE, "can_wake"),
        agentRow("broken-read", MACHINE, "can_wake"),
      ],
      computers: [],
    };
    h.handed.set("cc-here", {
      count: 2,
      countIsLowerBound: false,
      items: [
        { id: "s-1", goal: "g", startedAt: null },
        {
          id: "s-2",
          goal: "g",
          startedAt: null,
          resume: true,
          quietSince: null,
        },
      ],
    });
    h.handed.set("awake-here", {
      count: 1,
      countIsLowerBound: false,
      items: [{ id: "s-3", goal: "g", startedAt: null }],
    });
    h.handed.set("cc-elsewhere", {
      count: 1,
      countIsLowerBound: false,
      items: [{ id: "s-4", goal: "g", startedAt: null }],
    });
    h.handed.set("broken-read", { status: "unavailable" });

    const res = await get(appAs({ userId: PERSON, agentUserId: MACHINE }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wakesAgents: boolean;
      leaseMs: number;
      agents: Array<{ agentUserId: string; sessions: unknown[] }>;
      unreadable: string[];
    };
    expect(body.wakesAgents).toBe(true);
    expect(body.leaseMs).toBe(120_000);
    expect(body.agents.map((a) => a.agentUserId)).toEqual(["cc-here"]);
    expect(body.agents[0]!.sessions).toEqual([
      { id: "s-1" },
      { id: "s-2", resume: true },
    ]);
    expect(body.unreadable).toEqual(["broken-read"]);
    // The roster was read for the computer's person, AFTER this read renewed the lease.
    expect(h.rosterCalls).toEqual([{ userId: PERSON, stampedFirst: true }]);
    const stamp = await q<{ worker_served_version: string | null }>(
      `select worker_served_version from api_keys where id = $1`,
      [KEY]
    );
    expect(stamp.rows[0]!.worker_served_version).toBe("0.9.9");
  });

  it("with the switch off, an empty list that says so, and the roster is not read", async () => {
    await q(`UPDATE users SET agent_metadata = '{}' WHERE id = $1`, [MACHINE]);
    const res = await get(appAs({ userId: PERSON, agentUserId: MACHINE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      wakesAgents: false,
      agents: [],
      why: expect.stringContaining("Wakes agents"),
    });
    expect(h.rosterCalls).toHaveLength(0);
    await q(
      `UPDATE users SET agent_metadata = '{"wakesAgents": true}' WHERE id = $1`,
      [MACHINE]
    );
  });
});
