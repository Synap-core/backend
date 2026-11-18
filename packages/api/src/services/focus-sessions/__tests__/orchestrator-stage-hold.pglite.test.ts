/**
 * FOUNDER DECISION D-O1 ("enforce it now", 18 Nov 2026), on every door that
 * moves a session's stage: a session an orchestrator holds (`orchestrated_by`
 * an orchestrator whose `plan-approval` slot is unanswered) changes no stage.
 * MCP `synap_update_session`, tRPC `focusSessions.update` and Hub
 * `PATCH /focus-sessions/:id` each refuse it, name the orchestrator ("Waiting
 * on the orchestrator's plan: <title>"), write nothing and file NO proposal
 * (the gate is never asked). Once the person answers the plan, the same move
 * goes through. A session no orchestrator holds is unaffected.
 *
 * Real, on one PGlite with every table: the three doors and the ONE rule they
 * ask before writing (`refuseUndeclaredStage` → `orchestratorHolding`,
 * @synap/jobs). Stubbed: the `focus_session` gate (granted; its calls are
 * counted), post-commit delivery, the room mint — the harness of
 * `session-targets.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    /** The `focus_session` gate's answer, per test. */
    focusPerm: (async () => ({ granted: true })) as (
      o: Record<string, unknown>
    ) => Promise<unknown>,
    focusCalls: [] as Array<Record<string, unknown>>,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
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

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
// The `focus_session` gate is decided per test; every other subject (the end
// moves' and the status door's) reaches the REAL gate.
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<{
    checkPermissionOrPropose: (o: { subjectType?: string }) => unknown;
  }>();
  return {
    ...actual,
    checkPermissionOrPropose: async (o: Record<string, unknown>) => {
      if (o.subjectType !== "focus_session") {
        return actual.checkPermissionOrPropose(o);
      }
      h.focusCalls.push(o);
      return h.focusPerm(o);
    },
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";

const { sessionHandlers } =
  await import("../../../routers/mcp/handlers/session.js");

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();

async function seedSession(outputs: unknown[] = []): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Wave plan', $3, 'active', 'human', $4::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
    [id, USER, `Work ${id}`, JSON.stringify(outputs)]
  );
  return id;
}

const PLAN_APPROVAL = {
  key: "plan-approval",
  label: "Plan approval",
  kind: "decision",
  owner: "human",
  blockedReason: "decision",
};

/** A session held by an orchestrator whose plan is unanswered. */
async function held(): Promise<{ child: string; orchestrator: string }> {
  const orchestrator = await seedSession([PLAN_APPROVAL]);
  const child = await seedSession();
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_by, metadata, created_at)
     values ($1, 'session', $2, 'session', $3, 'orchestrated_by', $4, '{}'::jsonb, now())`,
    [randomUUID(), child, orchestrator, USER]
  );
  return { child, orchestrator };
}

const answerPlan = (orchestrator: string) =>
  q(`update focus_sessions set expected_outputs = $2::jsonb where id = $1`, [
    orchestrator,
    JSON.stringify([
      {
        ...PLAN_APPROVAL,
        answer: {
          text: "Yes",
          answeredBy: USER,
          answeredAt: new Date().toISOString(),
          value: { type: "confirm", confirmed: true },
        },
      },
    ]),
  ]);

const stageOf = async (id: string) =>
  (
    await q<{ current_stage: string | null }>(
      `select current_stage from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]?.current_stage ?? null;

const mcpUpdate = (args: Record<string, unknown>) =>
  sessionHandlers.synap_update_session!({
    toolName: "synap_update_session",
    args,
    userId: USER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never).then(
    (res) =>
      JSON.parse(
        (
          (res as { content: Array<{ text: string }> }).content[0] ?? {
            text: "{}",
          }
        ).text
      ) as Record<string, unknown>
  );

const trpc = () =>
  focusSessionsRouter.createCaller({
    userId: USER,
    authenticated: true,
  } as never);

function hub(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const hubPatch = (id: string, body: Record<string, unknown>) =>
  hub().request(`/focus-sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const WAITING = /Waiting on the orchestrator's plan: Wave plan/;

beforeAll(async () => {
  await h.init();
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Agent', 'a@x', 'agent', 'claude-code', '{}'::jsonb, $2)`,
    [AGENT, USER]
  );
}, 120_000);

beforeEach(() => {
  h.focusPerm = async () => ({ granted: true });
  h.focusCalls.length = 0;
});

describe("a held session changes no stage on any door (D-O1)", () => {
  it("MCP synap_update_session: refused with the orchestrator's name, nothing written, no proposal", async () => {
    const { child } = await held();
    const res = await mcpUpdate({ sessionId: child, currentStage: "build" });
    expect(String(res.error)).toMatch(WAITING);
    expect(res.status).not.toBe("proposed");
    expect(await stageOf(child)).toBeNull();
    expect(h.focusCalls).toHaveLength(0);
  });

  it("tRPC focusSessions.update: refused (BAD_REQUEST), nothing written", async () => {
    const { child } = await held();
    await expect(
      trpc().update({ id: child, currentStage: "build" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: WAITING });
    expect(await stageOf(child)).toBeNull();
    expect(h.focusCalls).toHaveLength(0);
  });

  it("Hub PATCH /focus-sessions/:id: refused (400), nothing written", async () => {
    const { child } = await held();
    const res = await hubPatch(child, { currentStage: "build" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(WAITING);
    expect(await stageOf(child)).toBeNull();
    expect(h.focusCalls).toHaveLength(0);
  });

  it("once the person answers the plan, the same move goes through on every door", async () => {
    const one = await held();
    const two = await held();
    const three = await held();
    for (const x of [one, two, three]) await answerPlan(x.orchestrator);
    const res = await mcpUpdate({ sessionId: one.child, currentStage: "build" });
    expect(res.error).toBeUndefined();
    expect(await stageOf(one.child)).toBe("build");
    await trpc().update({ id: two.child, currentStage: "build" } as never);
    expect(await stageOf(two.child)).toBe("build");
    expect((await hubPatch(three.child, { currentStage: "build" })).status).toBe(
      200
    );
    expect(await stageOf(three.child)).toBe("build");
  });

  it("a session no orchestrator holds is unaffected", async () => {
    const free = await seedSession();
    const res = await mcpUpdate({ sessionId: free, currentStage: "build" });
    expect(res.error).toBeUndefined();
    expect(await stageOf(free)).toBe("build");
  });
});
