/**
 * A RUN THAT CANNOT GO ON ENDS `failed` (playbook runtime fixes, lane E;
 * findings db27cac2, a00f5eb6, 15835191). An IS turn that reports
 * `outcome: failed` (every pod read failed, the turn threw, its first call did
 * not fit its budget), and a stopped run the pod can neither continue nor ask
 * about, end the run `failed` with the reason, post one notice in the room and
 * close the session `failed` through the ONE close door. Before, the run stayed
 * `running` and its session `active` until the 24-hour reaper.
 *
 * Driven through the REAL Hub door `POST /focus-sessions/:id/complete-run`,
 * the real `settleRunTurnEnd`, `applyRunCapture` and `completeFocusSession`,
 * read back out of PGlite built from the real schema.
 *
 * Stubbed, and why: the governance membrane (granted: its own suites), the
 * ephemeral proposal expiry (its own suite), the parent-automation settle
 * (CAPTURED), event appends and realtime (no transport), and the one turn door
 * `triggerAutoRespond` (its answer is the test's switch).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
      close: () => Promise<void>;
    },
    db: null as unknown,
    settled: [] as Array<Record<string, unknown>>,
    /** Whether the one turn door dispatches a continuation. */
    dispatchOk: true,
    /** Whether the run's ask to the person lands. */
    askOk: true,
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
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async (p: Record<string, unknown>) => {
    h.settled.push(p);
  },
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock(
  "../../proposals/expire-lapsed-proposals.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    expireSessionEphemerals: async () => 0,
  })
);
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  return {
    ...(await importOriginal<
      typeof import("../../../utils/channel-visibility.js")
    >()),
    channelVisibilityWhere: () => sql`true`,
  };
});
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => h.dispatchOk,
}));
vi.mock("../run-ask.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-ask.js")>();
  return {
    ...actual,
    raiseRunAsk: async (p: Parameters<typeof actual.raiseRunAsk>[0]) =>
      h.askOk ? actual.raiseRunAsk(p) : false,
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { MAX_AUTO_CONTINUATIONS, RUN_TURNS_META_KEY } from "../run-turn-end.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const IS_AGENT = "22222222-2222-4222-8222-222222222222";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** The IS's internal key: acting for the owner, its agent verified. */
function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, OWNER as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    c.set("agentUserId" as never, IS_AGENT as never);
    await next();
  });
  registerFocusSessionsRoutes(a as never);
  return a;
}

async function completeRun(
  sessionId: string,
  body: unknown
): Promise<{ code: number; json: Record<string, unknown> }> {
  const res = await app().request(`/focus-sessions/${sessionId}/complete-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    code: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function seedRun(
  opts: {
    origin?: string;
    expectedOutputs?: unknown[];
    metadata?: (runId: string) => Record<string, unknown>;
  } = {}
): Promise<{ sessionId: string; runId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Consolidate findings', now(), now())`,
    [channelId, OWNER]
  );
  const sessionId = randomUUID();
  const playbookId = randomUUID();
  const runId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, playbook_id, expected_outputs, stages, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Consolidate the open findings', 'Consolidate findings', 'active', $3, $4, $5::jsonb, '[]'::jsonb, $6, $7::jsonb, '[]'::jsonb, $8, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      opts.origin ?? "playbook",
      playbookId,
      JSON.stringify(opts.expectedOutputs ?? []),
      [IS_AGENT],
      JSON.stringify(opts.metadata?.(runId) ?? {}),
      channelId,
    ]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, definition_snapshot, created_by, started_at)
     values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, '{}'::jsonb, $4, now())`,
    [runId, playbookId, sessionId, OWNER]
  );
  return { sessionId, runId, channelId };
}

const sessionOf = async (sessionId: string) =>
  (
    await q<{
      status: string;
      closed_at: string | null;
      metadata: Record<string, unknown>;
    }>(`select status, closed_at, metadata from focus_sessions where id = $1`, [
      sessionId,
    ])
  ).rows[0]!;
const runOf = async (runId: string) =>
  (
    await q<{
      status: string;
      error: string | null;
      stop_reason: string | null;
      completed_at: string | null;
    }>(
      `select status, error, stop_reason, completed_at from playbook_runs where id = $1`,
      [runId]
    )
  ).rows[0]!;
const roomOf = async (channelId: string) =>
  (
    await q<{ role: string; content: string }>(
      `select role, content from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows;
const transitionsOf = async (sessionId: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [sessionId]
    )
  ).rows.map((r) => r.transition);

const failed = (reason: string) => ({
  outcome: "failed",
  reason,
  agentType: "meta",
  turnKey: randomUUID(),
});
const STOPPED = {
  outcome: "stopped",
  reason: "turn_budget",
  agentType: "meta",
};

describe("a run that cannot go on ends failed, and its session closes failed", () => {
  beforeAll(async () => {
    await h.init();
    for (const t of [
      schema.focusSessions,
      schema.playbookRuns,
      schema.playbooks,
      schema.proposals,
      schema.automationRuns,
      schema.channels,
      schema.channelMembers,
      schema.messages,
      schema.users,
      schema.apiKeys,
      schema.links,
      schema.tools,
      schema.notifications,
      schema.notificationPreferences,
      schema.lifecycleTransitionOutbox,
    ]) {
      await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'm@example.test', 'Synap AI', 'UTC', 'agent', 'meta')`,
      [OWNER, IS_AGENT]
    );
  }, 120_000);

  beforeEach(() => {
    h.dispatchOk = true;
    h.askOk = true;
    h.settled.length = 0;
  });

  afterAll(async () => {
    await h.client?.close();
  });

  it("a turn whose reads all failed: run failed, session failed by the system, one notice, the reason in the ledger", async () => {
    const { sessionId, runId, channelId } = await seedRun();
    const body = failed("read_failed");
    const r = await completeRun(sessionId, body);
    expect(r).toEqual({ code: 200, json: { status: "failed" } });

    const run = await runOf(runId);
    expect(run.status).toBe("failed");
    expect(run.completed_at).not.toBeNull();
    expect(run.error).toContain("could not reach the pod");
    // A fault, not a budget stop: the automation's breakers must see it.
    expect(run.stop_reason).toBeNull();
    expect(h.settled).toEqual([{ playbookRunId: runId }]);

    const s = await sessionOf(sessionId);
    expect(s.status).toBe("failed");
    expect(s.closed_at).not.toBeNull();
    expect(await transitionsOf(sessionId)).toEqual([
      expect.objectContaining({ to: "failed", actorKind: "system" }),
    ]);
    const turns = (
      s.metadata[RUN_TURNS_META_KEY] as { turns: Record<string, unknown>[] }
    ).turns;
    expect(turns.at(-1)).toMatchObject({
      outcome: "failed",
      reason: "read_failed",
    });

    const room = await roomOf(channelId);
    expect(room).toHaveLength(1);
    expect(room[0]!.role).toBe("system");
    expect(room[0]!.content).toContain("You can run it again");

    // A retry of the same report settles nothing twice.
    const again = await completeRun(sessionId, body);
    expect(again.json.status).toBe("no-running-run");
    expect(await roomOf(channelId)).toHaveLength(1);
  });

  it("a turn that threw ends turn_error; a first call over budget ends budget_exceeded, a budget stop", async () => {
    const thrown = await seedRun();
    expect(
      (await completeRun(thrown.sessionId, failed("turn_error"))).json
    ).toEqual({ status: "failed" });
    expect((await runOf(thrown.runId)).error).toContain("turn broke");
    expect((await sessionOf(thrown.sessionId)).status).toBe("failed");

    const wall = await seedRun();
    expect(
      (await completeRun(wall.sessionId, failed("budget_exceeded"))).json
    ).toEqual({ status: "failed" });
    const run = await runOf(wall.runId);
    expect(run.status).toBe("failed");
    expect(run.stop_reason).toBe("budget");
    expect((await sessionOf(wall.sessionId)).status).toBe("failed");
  });

  it("a slot the person owes keeps the session open where they will answer it; the run still ends", async () => {
    const { sessionId, runId } = await seedRun({
      expectedOutputs: [
        {
          key: "pick-areas",
          kind: "decision",
          label: "Pick the areas",
          owner: "human",
          status: "blocked",
          ask: { mode: "confirm", prompt: "Consolidate these areas?" },
        },
      ],
    });
    expect((await completeRun(sessionId, failed("turn_error"))).json).toEqual({
      status: "failed",
    });
    expect((await runOf(runId)).status).toBe("failed");
    expect((await sessionOf(sessionId)).status).toBe("active");
  });

  it("an unattended run whose continuation cannot be dispatched ends could_not_continue", async () => {
    h.dispatchOk = false;
    const { sessionId, runId } = await seedRun({ origin: "automation" });
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turnKey: randomUUID(),
    });
    expect(r.json).toEqual({ status: "failed" });
    const run = await runOf(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("could neither go on by itself nor ask you");
    expect((await sessionOf(sessionId)).status).toBe("failed");
  });

  it("an attended run whose continuations are spent and whose ask cannot land ends could_not_continue", async () => {
    h.askOk = false;
    const { sessionId, runId } = await seedRun({
      metadata: (id) => ({
        [RUN_TURNS_META_KEY]: {
          runId: id,
          stops: MAX_AUTO_CONTINUATIONS,
          autoContinues: MAX_AUTO_CONTINUATIONS,
          turns: [],
        },
      }),
    });
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turnKey: randomUUID(),
    });
    expect(r.json).toEqual({ status: "failed" });
    expect((await runOf(runId)).status).toBe("failed");
    expect((await sessionOf(sessionId)).status).toBe("failed");
  });

  it("refuses a failed outcome without a failure reason, and a stop reason on a failure", async () => {
    const { sessionId, runId } = await seedRun();
    for (const body of [
      { outcome: "failed" },
      { outcome: "failed", reason: "turn_budget" },
      { outcome: "stopped", reason: "turn_error" },
    ]) {
      expect((await completeRun(sessionId, body)).code).toBe(400);
    }
    expect((await runOf(runId)).status).toBe("running");
  });
});
