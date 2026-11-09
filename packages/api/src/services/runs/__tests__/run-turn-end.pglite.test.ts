/**
 * B8 (founder-approved 2026-10-21): a run whose IS turn stopped on its token
 * budget stays LIVE — it continues on its own twice, then asks the person —
 * driven through the REAL Hub door `POST /focus-sessions/:id/complete-run`,
 * the real `settleRunTurnEnd`, `applyRunCapture`, `postChannelMessage`, the
 * room-question → slot door, and read back out of PGlite.
 *
 * Before: complete-run marked the run `completed` after ANY turn, so a run
 * whose first turn hit its budget read completed 11 s in and no stall check
 * ever saw it.
 *
 * Stubbed, and why: `triggerAutoRespond` (CAPTURED at the one turn door —
 * pg-boss + IS resolution are its own suite; the call is what is under test),
 * the parent-automation settle (CAPTURED — automation tables are not in this
 * schema), Expo + the socket bridge + event appends (no transport), the
 * channel visibility predicate (its own suite).
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
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.triggers.push(p);
    return true;
  },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
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
  db,
} from "@synap/database";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import {
  CHECKPOINT_MAX_LEFT_CHARS,
  CHECKPOINT_MAX_RECORDS,
  MAX_AUTO_CONTINUATIONS,
  RUN_CONTINUE_SLOT_LABEL,
  checkpointTurnEntries,
  hasNoPersonInTheLoop,
  runTurnForAnswer,
  type RunTurnsState,
} from "../run-turn-end.js";
import { TurnContextSchema } from "../../../routers/channels/helpers.js";

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

/** A session room + its live is-agent run (what `runPlaybook` leaves). */
async function seedRun(): Promise<{
  sessionId: string;
  channelId: string;
  runId: string;
}> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Research a Question', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Research a Question', 'Research a Question', 'active', '[{"kind":"document","label":"Findings"}]'::jsonb, $3, '{"note":"kept"}'::jsonb, '[]'::jsonb, $4, now(), now(), now())`,
    [sessionId, OWNER, [IS_AGENT], channelId]
  );
  const runId = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, started_at)
     values ($1, $2, $3, 'is-agent', 'running', '{}'::jsonb, $4, now())`,
    [runId, randomUUID(), sessionId, OWNER]
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

const FIRST_CALL = {
  promptTokens: 131_072,
  reported: true,
  toolCount: 42,
  chars: { system: 210_000, tools: 260_000, history: 0, message: 900 },
};
const STOPPED = {
  outcome: "stopped",
  reason: "turn_budget",
  agentType: "researcher",
  turn: {
    budgetAction: "stop",
    ceiling: 250_000,
    spentInputTokens: 131_072,
    firstCall: FIRST_CALL,
    model: "claude-haiku-5-5",
    cacheReadInputTokens: 100_000,
    cacheWriteInputTokens: 20_000,
  },
};

async function completeRun(
  sessionId: string,
  body?: unknown
): Promise<{ code: number; json: Record<string, unknown> }> {
  const res = await app().request(`/focus-sessions/${sessionId}/complete-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    code: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const runRow = async (runId: string) =>
  (
    await q<{ status: string; completed_at: string | null }>(
      `select status, completed_at from playbook_runs where id = $1`,
      [runId]
    )
  ).rows[0]!;
const sessionRow = async (sessionId: string) =>
  (
    await q<{
      metadata: Record<string, unknown>;
      expected_outputs: Array<Record<string, unknown>>;
    }>(`select metadata, expected_outputs from focus_sessions where id = $1`, [
      sessionId,
    ])
  ).rows[0]!;
const ledger = async (sessionId: string) =>
  (await sessionRow(sessionId)).metadata.runTurns as RunTurnsState;
const roomMessages = async (channelId: string) =>
  (
    await q<{
      id: string;
      role: string;
      user_id: string;
      content: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select id, role, user_id, content, metadata from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows;

describe("complete-run settles the run from how the IS turn ended (B8)", () => {
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

  it("no body (an older IS) completes the run, as before — and settles its parent", async () => {
    const { sessionId, runId } = await seedRun();
    const r = await completeRun(sessionId);
    expect(r).toEqual({ code: 200, json: { status: "completed" } });
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(run.completed_at).not.toBeNull();
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
    expect(h.triggers).toHaveLength(0);
  });

  it("a budget STOP leaves the run live and continues it, N times, then asks the person", async () => {
    const { sessionId, channelId, runId } = await seedRun();

    // ── stops 1..N: the pod continues the run on its own ───────────────────
    for (let n = 1; n <= MAX_AUTO_CONTINUATIONS; n++) {
      const r = await completeRun(sessionId, STOPPED);
      expect(r).toEqual({ code: 200, json: { status: "continued" } });
      expect((await runRow(runId)).status).toBe("running");
      expect((await runRow(runId)).completed_at).toBeNull();
      expect(h.triggers).toHaveLength(n);
      const t = h.triggers[n - 1]!;
      // The SAME agent type, on the run's own session, as the next turn.
      expect(t).toMatchObject({
        channelId,
        focusSessionId: sessionId,
        agentType: "researcher",
        sourceUserId: OWNER,
      });
      // The trigger is a POD notice in the room, never the person speaking.
      const msg = (await roomMessages(channelId)).find(
        (m) => m.id === t.userMessageId
      )!;
      expect(msg.role).toBe("system");
      expect(msg.content).toContain(
        `Automatic continuation ${n} of ${MAX_AUTO_CONTINUATIONS}`
      );
      expect((await ledger(sessionId)).autoContinues).toBe(n);
    }
    expect(h.settled).toHaveLength(0);

    // ── stop N+1: the person is asked, the run waits on them ───────────────
    const asked = await completeRun(sessionId, STOPPED);
    expect(asked).toEqual({ code: 200, json: { status: "waiting_on_you" } });
    expect(h.triggers).toHaveLength(MAX_AUTO_CONTINUATIONS); // no 3rd turn
    const run = await runRow(runId);
    expect(run.status).toBe("waiting_on_you");
    expect(run.completed_at).toBeNull();
    const slot = (await sessionRow(sessionId)).expected_outputs.find(
      (s) => s.label === RUN_CONTINUE_SLOT_LABEL
    )!;
    expect(slot).toMatchObject({
      kind: "decision",
      owner: "human",
      blockedReason: "decision",
      ask: { mode: "confirm", prompt: "Keep it going?" },
    });
    // Said once: the facts are the why, the question only the prompt.
    expect(String(slot.why)).not.toContain("Keep it going?");
    expect(String(slot.why)).toContain(
      `stopped before it was finished ${MAX_AUTO_CONTINUATIONS + 1} times`
    );
    expect(String(slot.why)).toContain("hit its token budget");
    // The other declared slot is untouched.
    expect(
      (await sessionRow(sessionId)).expected_outputs.find(
        (s) => s.label === "Findings"
      )
    ).toEqual(expect.objectContaining({ kind: "document" }));
    // Asked as the turn's agent, in the room, filed on the slot.
    const questions = (await roomMessages(channelId)).filter(
      (m) =>
        (m.metadata?.roomPost as { kind?: string } | undefined)?.kind ===
        "question"
    );
    expect(questions).toHaveLength(1);
    const question = questions[0]!;
    expect(question.content).toContain("Keep it going?");
    expect(question.role).toBe("assistant");
    expect(question.metadata).toMatchObject({
      roomPost: { kind: "question", slotLabel: RUN_CONTINUE_SLOT_LABEL },
    });
    const l = await ledger(sessionId);
    expect(l).toMatchObject({
      runId,
      stops: MAX_AUTO_CONTINUATIONS + 1,
      autoContinues: 0,
    });
    // The first turn's measure is kept for reading later.
    expect(l.firstTurn).toMatchObject({
      outcome: "stopped",
      reason: "turn_budget",
      budgetAction: "stop",
      ceiling: 250_000,
      firstCall: FIRST_CALL,
      // Which model served the turn, and what its prompt cache did.
      model: "claude-haiku-5-5",
      cacheReadInputTokens: 100_000,
      cacheWriteInputTokens: 20_000,
      next: "continue",
    });
    expect(l.turns.map((t) => t.next)).toEqual([
      ...Array(MAX_AUTO_CONTINUATIONS).fill("continue"),
      "ask",
    ]);
    // A server-owned key MERGED into the bag: the rest of it is kept.
    expect((await sessionRow(sessionId)).metadata.note).toBe("kept");

    // ── after the ask the count starts again; a stop un-parks the run ──────
    const again = await completeRun(sessionId, STOPPED);
    expect(again.json).toEqual({ status: "continued" });
    expect((await runRow(runId)).status).toBe("running");

    // ── a turn that ends on its own completes it ──────────────────────────
    const done = await completeRun(sessionId, {
      outcome: "completed",
      agentType: "researcher",
      turn: { ceiling: 250_000, spentInputTokens: 9_000 },
    });
    expect(done.json).toEqual({ status: "completed" });
    expect((await runRow(runId)).status).toBe("completed");
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
  });

  it("an ask that does NOT land keeps the count: the next stop asks again, never a fresh continuation (M7)", async () => {
    // Before: the count was reset to 0 when the pod DECIDED to ask, inside the
    // recording transaction. An ask that then failed left the run running with
    // a fresh count, so the next stops continued twice more on fresh budgets,
    // asked (failed) again, and so on: unbounded spend, nobody asked.
    const { sessionId, runId } = await seedRun();
    for (let n = 1; n <= MAX_AUTO_CONTINUATIONS; n++) {
      expect((await completeRun(sessionId, STOPPED)).json).toEqual({
        status: "continued",
      });
    }

    h.failDeclare = true;
    const failed = await completeRun(sessionId, STOPPED);
    expect(failed.json).toEqual({ status: "left_running" });
    expect((await runRow(runId)).status).toBe("running");
    expect((await ledger(sessionId)).autoContinues).toBe(
      MAX_AUTO_CONTINUATIONS
    );

    // The next stop tries the ask again — it does NOT continue on its own.
    const again = await completeRun(sessionId, STOPPED);
    expect(again.json).toEqual({ status: "left_running" });
    expect(h.triggers).toHaveLength(MAX_AUTO_CONTINUATIONS);

    // Once an ask lands, the count resets for after the person answers.
    h.failDeclare = false;
    const asked = await completeRun(sessionId, STOPPED);
    expect(asked.json).toEqual({ status: "waiting_on_you" });
    expect(h.triggers).toHaveLength(MAX_AUTO_CONTINUATIONS);
    expect((await ledger(sessionId)).autoContinues).toBe(0);
  });

  it("a RETRIED report of one turn (same turnKey) is settled once: one stop, one continuation (S9)", async () => {
    // Before: the room post's idempotency key was the stop count, which the
    // retry had ALREADY incremented — so the retry counted a second stop and
    // posted (and dispatched) a second continuation.
    const { sessionId, channelId } = await seedRun();
    const report = { ...STOPPED, turnKey: "msg-turn-1" };
    expect((await completeRun(sessionId, report)).json).toEqual({
      status: "continued",
    });
    const retry = await completeRun(sessionId, report);
    expect(retry).toEqual({ code: 200, json: { status: "duplicate" } });
    expect(h.triggers).toHaveLength(1);
    expect(await ledger(sessionId)).toMatchObject({
      stops: 1,
      autoContinues: 1,
    });
    const notices = (await roomMessages(channelId)).filter(
      (m) => m.role === "system"
    );
    expect(notices).toHaveLength(1);

    // A DIFFERENT turn is a real stop.
    expect(
      (await completeRun(sessionId, { ...STOPPED, turnKey: "msg-turn-2" })).json
    ).toEqual({ status: "continued" });
    expect(h.triggers).toHaveLength(2);
    expect((await ledger(sessionId)).stops).toBe(2);
  });

  it("a FORCED-FINAL turn (budgetAction final) is a stop too, never a completion", async () => {
    const { sessionId, runId } = await seedRun();
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turn: { ...STOPPED.turn, budgetAction: "final" },
    });
    expect(r.json).toEqual({ status: "continued" });
    expect((await runRow(runId)).status).toBe("running");
  });

  it("a turn that stopped at its STEP limit is a stop too: the run stays live and continues (founder default 3)", async () => {
    // Before: the IS reported a step-limit turn as `completed` and the pod
    // only knew `turn_budget`, so the run read completed with its work undone.
    const { sessionId, channelId, runId } = await seedRun();
    const r = await completeRun(sessionId, {
      outcome: "stopped",
      reason: "max_steps",
      agentType: "researcher",
      turnKey: "msg-steps-1",
      turn: { ceiling: 250_000, spentInputTokens: 40_000 },
    });
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    const run = await runRow(runId);
    expect(run.status).toBe("running");
    expect(run.completed_at).toBeNull();
    expect(h.settled).toHaveLength(0);
    const notice = (await roomMessages(channelId)).find(
      (m) => m.id === h.triggers[0]!.userMessageId
    )!;
    expect(notice.content).toContain("stopped at its step limit");
    expect((await ledger(sessionId)).turns[0]).toMatchObject({
      outcome: "stopped",
      reason: "max_steps",
      next: "continue",
    });
  });

  it("a stopped run turn's checkpoint rides in the continuation by FULL id, and the continuation is a run turn (lean run tools, 2026-11-05)", async () => {
    // Before: the continuation said only "pick up from where it stopped"; the
    // next turn had the last answer's 8-character id prefixes and re-resolved
    // them (run 9d57a207: 170k more input tokens, finding 7726269d). And it
    // was dispatched with no run profile, so it got every tool again.
    const { sessionId, channelId, runId } = await seedRun();
    const IDEA = "9d57a207-1c2b-4d3e-8f40-5a6b7c8d9e0f";
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turnKey: "msg-checkpoint-1",
      checkpoint: {
        records: [{ id: IDEA, tool: "propose_entity_graph" }],
        left: "Left: move the 4 ideas that feed a post to Used.",
      },
    });
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    const notice = (await roomMessages(channelId)).find(
      (m) => m.id === h.triggers[0]!.userMessageId
    )!;
    expect(notice.content).toContain("```run-checkpoint");
    expect(notice.content).toContain(IDEA);
    expect(notice.content).toContain(
      "move the 4 ideas that feed a post to Used"
    );
    // The continuation carries the run's declared tools, like the kickoff.
    const [{ playbook_id }] = (
      await q<{ playbook_id: string }>(
        `select playbook_id from playbook_runs where id = $1`,
        [runId]
      )
    ).rows;
    expect(h.profiles).toEqual([
      expect.objectContaining({ playbookId: playbook_id, userId: OWNER }),
    ]);
    expect(h.triggers[0]!.run).toMatchObject({
      playbookId: playbook_id,
      verbs: ["postiz_schedule_post"],
    });
    expect((await ledger(sessionId)).turns[0]).toMatchObject({
      checkpointRecords: 1,
    });
  });

  it("an unusable checkpoint reads as absent: the turn still settles (never a 400)", async () => {
    const { sessionId, channelId } = await seedRun();
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turnKey: "msg-checkpoint-bad",
      checkpoint: { records: [{ id: "9d57a207", tool: "x" }], left: "" },
    });
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    const notice = (await roomMessages(channelId)).find(
      (m) => m.id === h.triggers[0]!.userMessageId
    )!;
    expect(notice.content).not.toContain("run-checkpoint");
  });

  it("one bad record is dropped ON ITS OWN: the rest of the checkpoint rides on (review of backend#816)", async () => {
    // Before: one record failing an RFC-only uuid check dropped the WHOLE
    // checkpoint (`.catch(undefined)` on the object), and a pod id with no
    // version nibble (the IS's own id shape) was such a record.
    const { sessionId, channelId } = await seedRun();
    const KEPT = "9d57a207-1c2b-0d3e-0f40-5a6b7c8d9e0f";
    const r = await completeRun(sessionId, {
      ...STOPPED,
      turnKey: "msg-checkpoint-mixed",
      checkpoint: {
        records: [
          { id: "9d57a207", tool: "update_entity" },
          { id: KEPT, tool: "create_entity" },
          { id: 42 },
        ],
        left: "Left: link the idea.",
      },
    });
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    const notice = (await roomMessages(channelId)).find(
      (m) => m.id === h.triggers[0]!.userMessageId
    )!;
    expect(notice.content).toContain("```run-checkpoint");
    expect(notice.content).toContain(KEPT);
    expect(notice.content).not.toContain('"9d57a207"');
    expect((await ledger(sessionId)).turns[0]).toMatchObject({
      checkpointRecords: 1,
    });
  });

  it("a YES to 'Keep the run going' wakes a RUN turn: the run's declared tools and the last stop's checkpoint as turn context (review of backend#816, #824)", async () => {
    const { sessionId } = await seedRun();
    const IDEA = "9d57a207-1c2b-4d3e-8f40-5a6b7c8d9e0f";
    await completeRun(sessionId, {
      ...STOPPED,
      turnKey: "msg-yes-1",
      checkpoint: {
        records: [{ id: IDEA, tool: "propose_entity_graph" }],
        left: "Left: move the ideas to Used.",
      },
    });
    expect((await ledger(sessionId)).lastCheckpoint).toEqual({
      records: [{ id: IDEA, tool: "propose_entity_graph" }],
      left: "Left: move the ideas to Used.",
    });
    h.profiles.length = 0;

    const yes = await runTurnForAnswer({
      sessionId,
      userId: OWNER,
      slotLabel: RUN_CONTINUE_SLOT_LABEL,
      approved: true,
    });
    expect(yes).toMatchObject({
      liveRun: "found",
      run: { verbs: ["postiz_schedule_post"] },
    });
    expect(h.profiles).toEqual([
      expect.objectContaining({ userId: OWNER, sessionId }),
    ]);
    const entries =
      yes.liveRun === "found" ? (yes.turnContext?.entries ?? []) : [];
    expect(entries).toContainEqual({
      key: "run.checkpoint.ids.1",
      value: [IDEA],
    });
    expect(entries).toContainEqual({
      key: "run.checkpoint.left",
      value: "Left: move the ideas to Used.",
    });

    // A NO, or another answer in a live run's room, is a run turn with no checkpoint.
    for (const other of [
      { slotLabel: RUN_CONTINUE_SLOT_LABEL, approved: false },
      { slotLabel: "Findings", approved: true },
    ]) {
      const r = await runTurnForAnswer({ sessionId, userId: OWNER, ...other });
      expect(r).toMatchObject({ liveRun: "found" });
      expect(r).not.toHaveProperty("turnContext");
    }
  });

  it("a later stop that reports NO checkpoint clears the last one: a stale one names records the run moved past (review of backend#824)", async () => {
    const { sessionId } = await seedRun();
    await completeRun(sessionId, {
      ...STOPPED,
      turnKey: "msg-stale-1",
      checkpoint: {
        records: [{ id: "9d57a207-1c2b-4d3e-8f40-5a6b7c8d9e0f", tool: "x" }],
        left: "Left: one thing.",
      },
    });
    expect((await ledger(sessionId)).lastCheckpoint).toBeDefined();
    await completeRun(sessionId, { ...STOPPED, turnKey: "msg-stale-2" });
    expect((await ledger(sessionId)).lastCheckpoint).toBeUndefined();
    const yes = await runTurnForAnswer({
      sessionId,
      userId: OWNER,
      slotLabel: RUN_CONTINUE_SLOT_LABEL,
      approved: true,
    });
    expect(yes).toMatchObject({ liveRun: "found" });
    expect(yes).not.toHaveProperty("turnContext");
  });

  it("a FAILED live-run lookup reads as failed, never as 'no run' (review of backend#824)", async () => {
    const { sessionId } = await seedRun();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("pool exhausted");
    });
    try {
      expect(
        await runTurnForAnswer({
          sessionId,
          userId: OWNER,
          slotLabel: RUN_CONTINUE_SLOT_LABEL,
          approved: true,
        })
      ).toEqual({ liveRun: "failed" });
    } finally {
      select.mockRestore();
    }
    expect(h.profiles).toHaveLength(0);
  });

  it("a FAILED checkpoint read keeps the run profile and tells the agent the checkpoint could not be read (review of backend#824)", async () => {
    const { sessionId } = await seedRun();
    const read = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockImplementationOnce(() => {
        throw new Error("metadata read failed");
      });
    try {
      const r = await runTurnForAnswer({
        sessionId,
        userId: OWNER,
        slotLabel: RUN_CONTINUE_SLOT_LABEL,
        approved: true,
      });
      expect(r).toEqual({
        liveRun: "found",
        run: expect.objectContaining({ verbs: ["postiz_schedule_post"] }),
        turnContext: {
          entries: [{ key: "run.checkpoint.read", value: "failed" }],
        },
      });
    } finally {
      read.mockRestore();
    }
  });

  it("the checkpoint's turn context stays inside the turn-context contract at its largest", () => {
    const records = Array.from({ length: CHECKPOINT_MAX_RECORDS }, (_, i) => ({
      id: `9d57a207-1c2b-4d3e-8f40-${String(i).padStart(12, "0")}`,
      tool: "t".repeat(200),
    }));
    const entries = checkpointTurnEntries({
      records,
      left: "x".repeat(CHECKPOINT_MAX_LEFT_CHARS),
    });
    expect(TurnContextSchema.safeParse({ entries }).success).toBe(true);
    expect(
      entries
        .filter((e) => e.key.startsWith("run.checkpoint.ids."))
        .flatMap((e) => e.value as string[])
    ).toEqual(records.map((r) => r.id));
    expect(entries).toContainEqual({
      key: "run.checkpoint.leftTruncated",
      value: true,
    });
  });

  it("an answer in a room with no live run wakes the normal agent (no run profile)", async () => {
    const { sessionId, runId } = await seedRun();
    await q(`update playbook_runs set status = 'completed' where id = $1`, [
      runId,
    ]);
    expect(
      await runTurnForAnswer({
        sessionId,
        userId: OWNER,
        slotLabel: RUN_CONTINUE_SLOT_LABEL,
        approved: true,
      })
    ).toEqual({ liveRun: "none" });
    expect(h.profiles).toHaveLength(0);
  });

  it("a malformed report is refused and changes nothing", async () => {
    const { sessionId, runId } = await seedRun();
    const r = await completeRun(sessionId, { outcome: "stopped" });
    expect(r.code).toBe(400);
    expect(String(r.json.error)).toMatch(/reason/);
    expect((await runRow(runId)).status).toBe("running");
    expect((await sessionRow(sessionId)).metadata.runTurns).toBeUndefined();
    expect(h.triggers).toHaveLength(0);
  });

  it("an agent type is a free string: one outside a slug pattern still settles the turn (FD5)", async () => {
    // Before: `agentType` had to match /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, so a
    // type with a space or a non-ASCII letter 400'd the WHOLE report — the
    // run's outcome was dropped and a finished run stayed `running`.
    const { sessionId, runId } = await seedRun();
    const r = await completeRun(sessionId, {
      ...STOPPED,
      agentType: "Équipe ventes (beta)",
    });
    expect(r).toEqual({ code: 200, json: { status: "continued" } });
    expect(h.triggers[0]).toMatchObject({ agentType: "Équipe ventes (beta)" });

    // A value the door cannot use (too long) reads as absent, never a 400.
    const done = await completeRun(sessionId, {
      outcome: "completed",
      agentType: "x".repeat(500),
    });
    expect(done).toEqual({ code: 200, json: { status: "completed" } });
    expect((await runRow(runId)).status).toBe("completed");
  });

  it("an unusable model or cache count reads as absent, never a 400 that drops the turn", async () => {
    const { sessionId, runId } = await seedRun();
    const done = await completeRun(sessionId, {
      outcome: "completed",
      turn: {
        ceiling: 250_000,
        spentInputTokens: 9_000,
        model: "",
        cacheReadInputTokens: -1,
        cacheWriteInputTokens: "many",
      },
    });
    expect(done).toEqual({ code: 200, json: { status: "completed" } });
    expect((await runRow(runId)).status).toBe("completed");
    const turn = (await ledger(sessionId)).firstTurn;
    expect(turn).toMatchObject({ spentInputTokens: 9_000 });
    expect(turn).not.toHaveProperty("model");
    expect(turn).not.toHaveProperty("cacheReadInputTokens");
    expect(turn).not.toHaveProperty("cacheWriteInputTokens");
  });

  it("the first call's inventory (sections, tools, guidance) lands in the ledger; bad values are dropped, never a 400", async () => {
    const inv = {
      sections: [
        { name: "persona", chars: 1_200 },
        { name: "method", chars: 8_400 },
      ],
      tools: ["synap_ask", "synap_capture"],
      guidance: ["kind:voice-guide"],
    };
    const ok = await seedRun();
    expect(
      (
        await completeRun(ok.sessionId, {
          outcome: "completed",
          turn: {
            ceiling: 250_000,
            spentInputTokens: 9_000,
            firstCall: { ...FIRST_CALL, ...inv },
          },
        })
      ).json
    ).toEqual({ status: "completed" });
    expect((await ledger(ok.sessionId)).firstTurn?.firstCall).toMatchObject(
      inv
    );

    // Each bad value reads as absent on its own; the counts and the turn stay.
    const bad = await seedRun();
    const done = await completeRun(bad.sessionId, {
      outcome: "completed",
      turn: {
        ceiling: 250_000,
        spentInputTokens: 9_000,
        firstCall: {
          ...FIRST_CALL,
          sections: [{ name: "", chars: -1 }],
          tools: "synap_ask",
          guidance: Array.from({ length: 13 }, (_, i) => `kind:k${i}`),
        },
      },
    });
    expect(done).toEqual({ code: 200, json: { status: "completed" } });
    const fc = (await ledger(bad.sessionId)).firstTurn?.firstCall;
    expect(fc).toMatchObject(FIRST_CALL);
    expect(fc).not.toHaveProperty("sections");
    expect(fc).not.toHaveProperty("tools");
    expect(fc).not.toHaveProperty("guidance");

    // An IS that predates the inventory sends none: the turn records as before.
    const old = await seedRun();
    await completeRun(old.sessionId, {
      outcome: "completed",
      turn: {
        ceiling: 250_000,
        spentInputTokens: 9_000,
        firstCall: FIRST_CALL,
      },
    });
    const ofc = (await ledger(old.sessionId)).firstTurn?.firstCall;
    expect(ofc).toEqual(FIRST_CALL);
  });

  it("the POD fills the turn's guidance from the run's stamped definition snapshot, over anything the IS sent", async () => {
    const { sessionId, runId } = await seedRun();
    await q(
      `update playbook_runs set definition_snapshot = $2::jsonb where id = $1`,
      [
        runId,
        JSON.stringify({
          guidance: {
            status: "ok",
            hash: "abc",
            used: [
              {
                ref: "kind:voice-guide",
                label: "Voice guide",
                hash: "h1",
                rows: [],
              },
              {
                ref: "skill:house-style",
                label: "House style",
                hash: "h2",
                rows: [],
              },
            ],
            demoted: [],
            missing: [],
          },
        }),
      ]
    );
    await completeRun(sessionId, {
      outcome: "completed",
      turn: {
        ceiling: 250_000,
        spentInputTokens: 9_000,
        firstCall: { ...FIRST_CALL, guidance: ["kind:from-the-is"] },
      },
    });
    expect((await ledger(sessionId)).firstTurn?.firstCall?.guidance).toEqual([
      "kind:voice-guide",
      "skill:house-style",
    ]);

    // A turn that reports no first call records none (nothing to attach to).
    const other = await seedRun();
    await q(
      `update playbook_runs set definition_snapshot = $2::jsonb where id = $1`,
      [
        other.runId,
        JSON.stringify({ guidance: { status: "unavailable", error: "x" } }),
      ]
    );
    await completeRun(other.sessionId, {
      outcome: "completed",
      turn: { ceiling: 1, spentInputTokens: 1, firstCall: FIRST_CALL },
    });
    expect(
      (await ledger(other.sessionId)).firstTurn?.firstCall
    ).not.toHaveProperty("guidance");
  });

  it("a ledger left by an EARLIER run on the session does not count for this one", async () => {
    const { sessionId, runId } = await seedRun();
    await q(`update focus_sessions set metadata = $2::jsonb where id = $1`, [
      sessionId,
      JSON.stringify({
        runTurns: {
          runId: randomUUID(),
          stops: 9,
          autoContinues: 2,
          turns: [],
        },
      }),
    ]);
    const r = await completeRun(sessionId, STOPPED);
    expect(r.json).toEqual({ status: "continued" });
    expect(await ledger(sessionId)).toMatchObject({
      runId,
      stops: 1,
      autoContinues: 1,
    });
  });

  // ── E3 (founder, 2026-10-27): no person in the loop, no person slot ─────
  // Before: a daily automation's run (CRM Hygiene) that kept stopping at its
  // budget put "Keep the run going" in the founder's Needs you.
  const unattended: Array<[string, string, Record<string, unknown>]> = [
    [
      "an automation's run (its automation keys)",
      "playbook",
      { automationId: "auto-1", automationRunId: "arun-1" },
    ],
    ["an automation-origin session", "automation", {}],
  ];
  for (const [name, origin, meta] of unattended) {
    it(`${name} that spends its continuations ENDS at its budget with a notice — never a person slot`, async () => {
      const { sessionId, channelId, runId } = await seedRun();
      await q(
        `update focus_sessions set origin = $2, metadata = metadata || $3::jsonb where id = $1`,
        [sessionId, origin, JSON.stringify(meta)]
      );
      for (let n = 1; n <= MAX_AUTO_CONTINUATIONS; n++) {
        expect((await completeRun(sessionId, STOPPED)).json).toEqual({
          status: "continued",
        });
      }
      const r = await completeRun(sessionId, STOPPED);
      expect(r).toEqual({ code: 200, json: { status: "stopped" } });
      expect(h.triggers).toHaveLength(MAX_AUTO_CONTINUATIONS);

      const run = (
        await q<{
          status: string;
          error: string | null;
          completed_at: string | null;
          stop_reason: string | null;
        }>(
          `select status, error, completed_at, stop_reason from playbook_runs where id = $1`,
          [runId]
        )
      ).rows[0]!;
      expect(run.status).toBe("failed");
      expect(run.completed_at).not.toBeNull();
      expect(run.error).toContain("Stopped at its token budget");
      // A stop, not a fault: the parent's breakers read this (founder F3).
      expect(run.stop_reason).toBe("budget");
      expect(h.settled).toEqual([{ playbookRunId: runId }]);

      // Nobody was asked: no slot, no question in the room.
      const slots = (await sessionRow(sessionId)).expected_outputs;
      expect(
        slots.find((s) => s.label === RUN_CONTINUE_SLOT_LABEL)
      ).toBeUndefined();
      expect(slots.some((s) => s.owner === "human")).toBe(false);
      const room = await roomMessages(channelId);
      expect(
        room.filter(
          (m) =>
            (m.metadata?.roomPost as { kind?: string } | undefined)?.kind ===
            "question"
        )
      ).toHaveLength(0);
      // The notice says why, as the pod.
      const notice = room.at(-1)!;
      expect(notice.role).toBe("system");
      expect(notice.content).toContain("nobody was asked to keep it going");
    });
  }

  it("an automation's run a PERSON took on from triage still asks them (they are in the loop)", async () => {
    const { sessionId, runId } = await seedRun();
    await q(
      `update focus_sessions set metadata = metadata || $2::jsonb where id = $1`,
      [
        sessionId,
        JSON.stringify({
          automationId: "auto-1",
          triage: { acceptedAt: new Date().toISOString() },
        }),
      ]
    );
    for (let n = 1; n <= MAX_AUTO_CONTINUATIONS; n++) {
      await completeRun(sessionId, STOPPED);
    }
    const r = await completeRun(sessionId, STOPPED);
    expect(r.json).toEqual({ status: "waiting_on_you" });
    expect((await runRow(runId)).status).toBe("waiting_on_you");
  });

  it("hasNoPersonInTheLoop reads origin, the automation keys and the triage receipt", () => {
    expect(hasNoPersonInTheLoop({ origin: "playbook", metadata: {} })).toBe(
      false
    );
    expect(hasNoPersonInTheLoop({ origin: "human", metadata: null })).toBe(
      false
    );
    expect(hasNoPersonInTheLoop({ origin: "automation", metadata: null })).toBe(
      true
    );
    expect(
      hasNoPersonInTheLoop({
        origin: "playbook",
        metadata: { automationRunId: "r" },
      })
    ).toBe(true);
    expect(
      hasNoPersonInTheLoop({
        origin: "automation",
        metadata: { triage: { acceptedAt: "2026-10-27T00:00:00Z" } },
      })
    ).toBe(false);
  });
});
