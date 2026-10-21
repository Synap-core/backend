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
vi.mock("../../../utils/channel-visibility.js", async () => {
  const { sql } = await import("drizzle-orm");
  return { channelVisibilityWhere: () => sql`true` };
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
} from "@synap/database";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import {
  MAX_AUTO_CONTINUATIONS,
  RUN_CONTINUE_SLOT_LABEL,
  type RunTurnsState,
} from "../run-turn-end.js";

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
      ask: { mode: "confirm" },
    });
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
      (await completeRun(sessionId, { ...STOPPED, turnKey: "msg-turn-2" }))
        .json
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
});
