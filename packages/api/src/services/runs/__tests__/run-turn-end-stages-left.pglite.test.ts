/**
 * A COMPLETED TURN NEVER COMPLETES A STAGED RUN WITH STAGES LEFT (plan
 * 7d71ddcc wave 0, founder decision D4, 16 Nov 2026).
 *
 * The defect (session 12dbd086): a Produce Content run (brief → script →
 * draft → review → schedule → publish, gates on draft, review and publish, no
 * stage declaring an `endAsk`) did ONE IS turn that reported `completed`
 * while it still stood on `brief`. `settleRunTurnEnd` completed the run
 * (`applyRunCapture` completed), and the hourly sweep closed its session.
 * Now that turn's end is a STOP (`stages_left`): the run continues on its own
 * twice, then the person is asked "Continue at Brief?"; with no person in the
 * loop it ends `failed`, `stop_reason = 'stages_left'`, with a room notice.
 *
 * NEGATIVE CONTROL: the first test reads `completed` on the code before this
 * change (run with the fix reverted; see the commit message).
 *
 * Driven through the REAL Hub door `POST /focus-sessions/:id/complete-run`,
 * the real `settleRunTurnEnd`, `applyRunCapture`, `postChannelMessage`, the
 * room-question → slot door, read back out of PGlite. Stubbed as in
 * `stage-end-ask.pglite.test.ts`, and for the same reasons.
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

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  triggers: [] as Array<Record<string, unknown>>,
  settled: [] as Array<Record<string, unknown>>,
  /** When set, the ask's slot declaration fails (the ask does not land). */
  failDeclare: false,
  /** Every run-tool-profile resolution (its own suite: run-tool-profile.test.ts). */
  profiles: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
        users: actual.users as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
        apiKeys: actual.apiKeys as never,
        links: actual.links as never,
        tools: actual.tools as never,
        playbookRuns: actual.playbookRuns as never,
        entities: actual.entities as never,
        relations: actual.relations as never,
      },
    }),
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
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
// Pass-through: the REAL locked slot write, except when a test makes the ask
// fail to land (the M7 precondition) — the declaration then returns false,
// exactly what `updateExpectedOutputsLocked` answers for a vanished row.
vi.mock("../../focus-sessions/delegate-output.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.updateExpectedOutputsLocked as (
    ...a: unknown[]
  ) => Promise<boolean>;
  return {
    ...actual,
    updateExpectedOutputsLocked: async (...a: unknown[]) =>
      h.failDeclare ? false : real(...a),
  };
});
vi.mock("../../playbooks/run-tool-profile.js", () => ({
  resolveRunToolProfile: async (p: Record<string, unknown>) => {
    h.profiles.push(p);
    return {
      playbookId: p.playbookId,
      intents: ["publish_post"],
      verbs: ["postiz_schedule_post"],
      capabilitiesRead: "ok",
    };
  },
}));
vi.mock("../../decisions/decision-entity-door.js", () => ({
  createDecisionEntity: async () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  updateDecisionEntity: async () => undefined,
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));
vi.mock("../../focus-sessions/accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async () => undefined,
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.triggers.push(p);
    return true;
  },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  relations,
  focusSessions,
  notifications,
  notificationPreferences,
  users,
  channels,
  channelMembers,
  messages,
  apiKeys,
  links,
  tools,
  playbookRuns,
  lifecycleTransitionOutbox,
  sessionStageRuns,
} from "@synap/database";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { type RunTurnsState } from "../run-turn-end.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const IS_AGENT = "22222222-2222-4222-8222-222222222222";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Produce Content, as session 12dbd086 ran it. */
const PRODUCE = [
  { key: "brief", name: "Brief", category: "planned" },
  { key: "script", name: "Script", category: "started" },
  { key: "draft", name: "Draft", category: "started", gate: { kind: "human" } },
  {
    key: "review",
    name: "Review",
    category: "started",
    gate: { kind: "human" },
  },
  { key: "schedule", name: "Schedule", category: "started" },
  {
    key: "publish",
    name: "Publish",
    category: "completed",
    gate: { kind: "human" },
  },
];

/** A session room + its live is-agent run on a STAGED playbook. */
async function seedRun(
  stages: unknown[],
  opts: {
    currentStage?: string;
    origin?: string;
    status?: string;
    expectedOutputs?: unknown[];
  } = {}
): Promise<{ sessionId: string; channelId: string; runId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Produce content', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, expected_outputs, agent_ids, metadata, criteria, channel_id, stages, current_stage, created_at, updated_at, started_at)
     values ($1, $2, 'Produce content', 'Produce content', $3, $4, $5::jsonb, $6, '{}'::jsonb, '[]'::jsonb, $7, $8::jsonb, $9, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      opts.status ?? "active",
      opts.origin ?? "playbook",
      JSON.stringify(opts.expectedOutputs ?? []),
      [IS_AGENT],
      channelId,
      JSON.stringify(stages),
      opts.currentStage ?? (stages[0] as { key: string } | undefined)?.key,
    ]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, definition_snapshot, started_at)
     values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, $4, $5::jsonb, now())`,
    [runId, randomUUID(), sessionId, OWNER, JSON.stringify({ stages })]
  );
  return { sessionId, channelId, runId };
}

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

const COMPLETED = (turnKey: string) => ({
  outcome: "completed",
  agentType: "researcher",
  turnKey,
  turn: { ceiling: 250_000, spentInputTokens: 9_000 },
});

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

const runRow = async (runId: string) =>
  (
    await q<{
      status: string;
      completed_at: string | null;
      error: string | null;
      stop_reason: string | null;
    }>(
      `select status, completed_at, error, stop_reason from playbook_runs where id = $1`,
      [runId]
    )
  ).rows[0]!;
const sessionRow = async (sessionId: string) =>
  (
    await q<{
      status: string;
      metadata: Record<string, unknown>;
      expected_outputs: Array<Record<string, unknown>>;
    }>(
      `select status, metadata, expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;
const ledger = async (sessionId: string) =>
  (await sessionRow(sessionId)).metadata.runTurns as RunTurnsState;
const owed = async (sessionId: string) =>
  (await sessionRow(sessionId)).expected_outputs.filter(
    (s) => s.owner === "human"
  );
const roomPosts = async (channelId: string) =>
  (
    await q<{ role: string; content: string }>(
      `select role, content from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows;

describe("a completed turn never completes a staged run with stages left", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      notifications,
      notificationPreferences,
      users,
      channels,
      channelMembers,
      messages,
      apiKeys,
      links,
      tools,
      playbookRuns,
      entities,
      relations,
      sessionStageRuns,
      lifecycleTransitionOutbox,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher')`,
      [OWNER, IS_AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.triggers.length = 0;
    h.settled.length = 0;
    h.profiles.length = 0;
    h.failDeclare = false;
  });

  it("12dbd086: one completed turn still on Brief is a STOP — the run stays live and goes on by itself, told the stages left", async () => {
    const { sessionId, channelId, runId } = await seedRun(PRODUCE);

    const r = await completeRun(sessionId, COMPLETED("t-1"));

    // Before the fix: { status: "completed" }, the run completed on Brief.
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    const run = await runRow(runId);
    expect(run.status).toBe("running");
    expect(run.completed_at).toBeNull();
    expect(h.settled).toEqual([]);
    // The continuation is dispatched through the one turn door, as a run turn.
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({
      channelId,
      focusSessionId: sessionId,
      agentType: "researcher",
    });
    const notice = String(h.triggers[0]!.content);
    expect(notice).toContain("Automatic continuation 1 of 2");
    expect(notice).toContain("ended at Brief");
    expect(notice).toContain(
      "5 stages left (Script, Draft, Review, Schedule, Publish)"
    );
    // The ledger records the turn as a stop, the pod's reason.
    const l = await ledger(sessionId);
    expect(l.stops).toBe(1);
    expect(l.autoContinues).toBe(1);
    expect(l.turns.at(-1)).toMatchObject({
      turnKey: "t-1",
      outcome: "stopped",
      reason: "stages_left",
      next: "continue",
    });
    expect(l.firstTurn).toMatchObject({ outcome: "stopped" });
    // Nothing is owed by the person yet.
    expect(await owed(sessionId)).toHaveLength(0);
    expect((await sessionRow(sessionId)).status).toBe("active");
  });

  it("a RETRIED report of that turn is a duplicate: no second stop, no second continuation", async () => {
    const { sessionId } = await seedRun(PRODUCE);
    await completeRun(sessionId, COMPLETED("t-r"));
    const again = await completeRun(sessionId, COMPLETED("t-r"));
    expect(again.json).toEqual({ status: "duplicate" });
    expect((await ledger(sessionId)).stops).toBe(1);
    expect(h.triggers).toHaveLength(1);
  });

  it("after two continuations the person is asked, naming the stage: Continue at Script?", async () => {
    const { sessionId, channelId, runId } = await seedRun(PRODUCE, {
      currentStage: "script",
    });
    expect((await completeRun(sessionId, COMPLETED("a-1"))).json).toEqual({
      status: "continued",
    });
    expect((await completeRun(sessionId, COMPLETED("a-2"))).json).toEqual({
      status: "continued",
    });
    const third = await completeRun(sessionId, COMPLETED("a-3"));
    expect(third.json).toEqual({ status: "waiting_on_you" });
    expect((await runRow(runId)).status).toBe("waiting_on_you");
    const slots = await owed(sessionId);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "decision",
      label: "Keep the run going",
      owner: "human",
      unblocks: "The run goes on at Script",
      ask: { mode: "confirm", prompt: "Continue at Script?" },
    });
    expect(String(slots[0]!.why)).toContain(
      "The run stopped at Script, with 4 stages left"
    );
    // ONE question in the room, as the run's agent; no third continuation.
    const asked = (await roomPosts(channelId)).filter(
      (m) => m.role === "assistant"
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.content).toContain("Continue at Script?");
    expect(h.triggers).toHaveLength(2);
    // The ask landed: the next stops get fresh continuations.
    expect((await ledger(sessionId)).autoContinues).toBe(0);
  });

  it("NO PERSON IN THE LOOP: after two continuations the run ends failed, stop_reason stages_left, with a room notice", async () => {
    const { sessionId, channelId, runId } = await seedRun(PRODUCE, {
      origin: "automation",
    });
    await completeRun(sessionId, COMPLETED("u-1"));
    await completeRun(sessionId, COMPLETED("u-2"));
    const third = await completeRun(sessionId, COMPLETED("u-3"));
    expect(third.json).toEqual({ status: "stopped" });
    const run = await runRow(runId);
    expect(run.status).toBe("failed");
    // Counted by the automation's breakers: only `budget` is exempt.
    expect(run.stop_reason).toBe("stages_left");
    expect(run.error).toContain("Stopped at Brief with 5 stages left");
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
    // Nobody was asked.
    expect(await owed(sessionId)).toHaveLength(0);
    const notice = (await roomPosts(channelId)).filter(
      (m) => m.role === "system" && m.content.startsWith("Stopped at Brief")
    );
    expect(notice).toHaveLength(1);
    expect(notice[0]!.content).toContain(
      "An automation started it, so nobody was asked to keep it going."
    );
  });

  it("at its LAST stage the completed turn completes the run, as before", async () => {
    const { sessionId, runId } = await seedRun(PRODUCE, {
      currentStage: "publish",
    });
    expect((await completeRun(sessionId, COMPLETED("l-1"))).json).toEqual({
      status: "completed",
    });
    expect((await runRow(runId)).status).toBe("completed");
    expect(h.triggers).toHaveLength(0);
  });

  it("a session PAUSED at a gate: the run stays live for the gate, never completed under it", async () => {
    const { sessionId, runId } = await seedRun(PRODUCE, {
      currentStage: "draft",
      status: "paused",
    });
    expect((await completeRun(sessionId, COMPLETED("p-1"))).json).toEqual({
      status: "left_running",
    });
    expect((await runRow(runId)).status).toBe("running");
    expect(h.triggers).toHaveLength(0);
    expect((await ledger(sessionId)).stops).toBe(0);
  });

  it("the person answered NO to keeping it going: the completed turn completes the run (they stopped it)", async () => {
    const { sessionId, runId } = await seedRun(PRODUCE, {
      currentStage: "script",
      expectedOutputs: [
        {
          kind: "decision",
          label: "Keep the run going",
          status: "pending",
          answer: {
            text: "No",
            messageId: null,
            answeredBy: OWNER,
            answeredAt: "2026-11-16T10:00:00.000Z",
            value: { type: "confirm", confirmed: false },
          },
        },
      ],
    });
    expect((await completeRun(sessionId, COMPLETED("n-1"))).json).toEqual({
      status: "completed",
    });
    expect((await runRow(runId)).status).toBe("completed");
  });

  it("a run with no tool to move its stage (a short run: two stages, no gate) completes as before", async () => {
    const SHORT = [
      { key: "draft", name: "Draft" },
      { key: "post", name: "Post" },
    ];
    const { sessionId, runId } = await seedRun(SHORT);
    expect((await completeRun(sessionId, COMPLETED("s-1"))).json).toEqual({
      status: "completed",
    });
    expect((await runRow(runId)).status).toBe("completed");
    expect(h.triggers).toHaveLength(0);
  });
});
