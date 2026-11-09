/**
 * A ONE-TURN RUN ENDS ITSELF (founder, 9 Nov 2026). When an IS turn reports
 * `completed` on a run with no stages, the run completes AND its session is
 * closed at once, through the ONE close door, unless something in it waits on
 * the person. Before: the session stayed active until the hourly sweep (the
 * caption run `1e0e3210` read "Writing the caption…" for 50 minutes after its
 * run completed).
 *
 * Driven through the REAL Hub door `POST /focus-sessions/:id/complete-run`,
 * the real `settleRunTurnEnd`, `applyRunCapture`,
 * `closeStagelessRunSessionAtTurnEnd` and `completeFocusSession`, read back
 * out of PGlite built from the real schema.
 *
 * Stubbed, and why: the governance membrane (granted: its own suites; the
 * close passes the same parameters as the hourly sweep's), the ephemeral
 * proposal expiry (its own suite), the parent-automation settle (CAPTURED),
 * event appends and realtime (no transport).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { ENDED_RUN_CLOSE_SUMMARY } from "../../focus-sessions/session-lifecycle-sweep.js";
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

/** What the caption run's second turn reported (session 1e0e3210). */
const COMPLETED = {
  outcome: "completed",
  agentType: "meta",
  turn: {
    ceiling: 250_000,
    spentInputTokens: 54_247,
    chargedInputTokens: 30_705,
    model: "claude-sonnet-5-5",
    cacheReadInputTokens: 26_158,
    cacheWriteInputTokens: 28_083,
  },
};

const CAPTION_DRAFT = {
  key: "caption-draft",
  kind: "document",
  label: "Caption draft",
};

/**
 * What `runPlaybook` leaves for a playbook run: a `playbook`-origin session
 * with its room, and its live is-agent run. `stages` are the session's own;
 * `snapshotStages` are the run's frozen definition's.
 */
async function seedRun(opts: {
  expectedOutputs?: unknown[];
  stages?: unknown[];
  snapshotStages?: unknown[];
  origin?: string | null;
}): Promise<{ sessionId: string; runId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Write the caption', now(), now())`,
    [channelId, OWNER]
  );
  const sessionId = randomUUID();
  const playbookId = randomUUID();
  const origin = opts.origin === undefined ? "playbook" : opts.origin;
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, playbook_id, expected_outputs, stages, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Write the caption for Carousel 01', 'Write the caption · Carousel 01', 'active', $3, $4, $5::jsonb, $6::jsonb, $7, '{}'::jsonb, '[]'::jsonb, $8, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      origin,
      origin === null ? null : playbookId,
      JSON.stringify(opts.expectedOutputs ?? [CAPTION_DRAFT]),
      JSON.stringify(opts.stages ?? []),
      [IS_AGENT],
      channelId,
    ]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, definition_snapshot, created_by, started_at)
     values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, $4::jsonb, $5, now())`,
    [
      runId,
      playbookId,
      sessionId,
      JSON.stringify(
        opts.snapshotStages ? { stages: opts.snapshotStages } : {}
      ),
      OWNER,
    ]
  );
  return { sessionId, runId, channelId };
}

const sessionOf = async (sessionId: string) =>
  (
    await q<{
      status: string;
      closed_at: string | null;
      verification_report: Record<string, unknown> | null;
      metadata: Record<string, unknown>;
    }>(
      `select status, closed_at, verification_report, metadata from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;
const runOf = async (runId: string) =>
  (
    await q<{ status: string }>(
      `select status from playbook_runs where id = $1`,
      [runId]
    )
  ).rows[0]!;

const STAGES = [
  { key: "draft", label: "Draft" },
  { key: "review", label: "Review" },
];

describe("a one-turn run ends itself when its turn completes", () => {
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

  afterAll(async () => {
    await h.client?.close();
  });

  it("a stageless run with nothing owed: the run completes and its session closes, through the one door", async () => {
    const { sessionId, runId } = await seedRun({});
    const r = await completeRun(sessionId, COMPLETED);
    expect(r).toEqual({ code: 200, json: { status: "completed" } });
    expect((await runOf(runId)).status).toBe("completed");
    const s = await sessionOf(sessionId);
    expect(s.status).toBe("closed");
    expect(s.closed_at).not.toBeNull();
    expect(s.verification_report).toMatchObject({
      summary: ENDED_RUN_CLOSE_SUMMARY,
    });
    // The close transition is the system's, recorded by the one door.
    const outbox = (
      await q<{ payload: Record<string, unknown> }>(
        `select payload from lifecycle_transition_outbox where payload->>'subjectId' = $1`,
        [sessionId]
      )
    ).rows;
    expect(outbox.map((o) => o.payload)).toEqual([
      expect.objectContaining({
        to: "closed",
        actor: expect.objectContaining({ kind: "system" }),
      }),
    ]);
    // What the turn counted against its ceiling is in the ledger.
    const turns = (s.metadata.runTurns as { turns: Record<string, unknown>[] })
      .turns;
    expect(turns.at(-1)).toMatchObject({
      spentInputTokens: 54_247,
      chargedInputTokens: 30_705,
      cacheReadInputTokens: 26_158,
    });
  });

  it("a slot the person owes keeps the session open where they will answer it", async () => {
    const { sessionId, runId } = await seedRun({
      expectedOutputs: [
        CAPTION_DRAFT,
        {
          key: "use-this-caption",
          kind: "decision",
          label: "Use this caption",
          owner: "human",
          status: "blocked",
          ask: { mode: "confirm", prompt: "Use this caption?" },
        },
      ],
    });
    const r = await completeRun(sessionId, COMPLETED);
    expect(r.json.status).toBe("completed");
    expect((await runOf(runId)).status).toBe("completed");
    expect((await sessionOf(sessionId)).status).toBe("active");
  });

  it("a proposal waiting for the person keeps the session open", async () => {
    const { sessionId } = await seedRun({});
    await q(
      `insert into proposals (id, user_id, session_id, status, proposal_type, target_type, data, created_at, updated_at)
       values ($1, $2, $3, 'pending', 'update', 'document', '{}'::jsonb, now(), now())`,
      [randomUUID(), OWNER, sessionId]
    );
    await completeRun(sessionId, COMPLETED);
    expect((await sessionOf(sessionId)).status).toBe("active");
  });

  it("a STAGED run is never closed at a turn's end: stages on the session, or on the run's frozen definition", async () => {
    const onSession = await seedRun({ stages: STAGES });
    const onSnapshot = await seedRun({ snapshotStages: STAGES });
    for (const { sessionId, runId } of [onSession, onSnapshot]) {
      const r = await completeRun(sessionId, COMPLETED);
      expect(r.json.status).toBe("completed");
      expect((await runOf(runId)).status).toBe("completed");
      expect((await sessionOf(sessionId)).status).toBe("active");
    }
  });

  it("a WORK session (no run origin) that holds a run is left to its owner", async () => {
    const { sessionId, runId } = await seedRun({ origin: null });
    await completeRun(sessionId, COMPLETED);
    expect((await runOf(runId)).status).toBe("completed");
    expect((await sessionOf(sessionId)).status).toBe("active");
  });

  it("a STOPPED turn never closes: the run stays live", async () => {
    const { sessionId, runId } = await seedRun({});
    const r = await completeRun(sessionId, {
      outcome: "stopped",
      reason: "turn_budget",
      agentType: "meta",
      turnKey: randomUUID(),
    });
    expect(r.json.status).toBe("continued");
    expect((await runOf(runId)).status).toBe("running");
    expect((await sessionOf(sessionId)).status).toBe("active");
  });
});
