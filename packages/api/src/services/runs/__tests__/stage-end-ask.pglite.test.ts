/**
 * THE POD RAISES A STAGE'S ASK; RUNS NEVER ASK (plan 08e4fba7 decision 5,
 * founder 9 Nov 2026). A staged run whose stage declares `endAsk` ends that
 * stage's turn with exactly ONE owed slot the pod raised (right mode and
 * options, no turn dispatched, no agent tool), waits on the person, and the
 * person's answer wakes a RUN turn whose context names the next stage. A run
 * whose stages declare no ask completes exactly as before.
 *
 * Driven through the REAL Hub door `POST /focus-sessions/:id/complete-run`,
 * the real `settleRunTurnEnd` → `settleStageEndAsk` → `raiseRunAsk`, the
 * room-question → slot door, the REAL answer door (`answerSessionSlot`) and
 * its wake, read back out of PGlite.
 *
 * Stubbed, and why: the same as `run-turn-end.pglite.test.ts`
 * (`triggerAutoRespond` CAPTURED at the one turn door, the parent-automation
 * settle, transports, the channel visibility predicate), plus the answer
 * door's decision record and link writer (their own suites:
 * `decision-slot-never-bare.pglite.test.ts`).
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
} from "@synap/database";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { type RunTurnsState } from "../run-turn-end.js";
import { answerSessionSlot } from "../../focus-sessions/session-answer.js";
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

const LABEL = "Next week's priorities";
const PRIORITIES_ASK = {
  mode: "choose",
  options: [
    {
      label: "The three the review recommends",
      value: "recommended",
      recommended: true,
    },
    { label: "No new priorities", value: "none" },
  ],
};
/** Weekly review, as the catalog declares it after this change. */
const WEEKLY_STAGES = [
  { key: "collect", name: "Collect", category: "started", goal: "List." },
  {
    key: "review",
    name: "Review",
    category: "started",
    goal: "List what is stuck.",
    endAsk: {
      label: LABEL,
      why: "The weekly review is listed above.",
      unblocks: "The run creates a task for each priority",
      ask: PRIORITIES_ASK,
    },
  },
  {
    key: "plan",
    name: "Plan",
    category: "completed",
    goal: "Create a task for each priority the person chose.",
  },
];

/** A session room + its live is-agent run on a STAGED playbook. */
async function seedRun(
  stages: unknown[],
  opts: { currentStage?: string; subjectEntityId?: string } = {}
): Promise<{ sessionId: string; channelId: string; runId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Weekly review', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  const current =
    opts.currentStage ?? (stages[0] as { key: string } | undefined)?.key;
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, stages, current_stage, subject_entity_id, created_at, updated_at, started_at)
     values ($1, $2, 'Weekly review', 'Weekly review', 'active', '[{"kind":"document","label":"Findings"}]'::jsonb, $3, '{}'::jsonb, '[]'::jsonb, $4, $5::jsonb, $6, $7, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      [IS_AGENT],
      channelId,
      JSON.stringify(stages),
      current ?? null,
      opts.subjectEntityId ?? null,
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
      current_stage: string | null;
    }>(
      `select metadata, expected_outputs, current_stage from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;
const ledger = async (sessionId: string) =>
  (await sessionRow(sessionId)).metadata.runTurns as RunTurnsState;
const owed = async (sessionId: string) =>
  (await sessionRow(sessionId)).expected_outputs.filter(
    (s) => s.owner === "human"
  );
const questions = async (channelId: string) =>
  (
    await q<{
      id: string;
      role: string;
      content: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select id, role, content, metadata from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows.filter(
    (m) =>
      (m.metadata?.roomPost as { kind?: string } | undefined)?.kind ===
      "question"
  );

describe("the pod raises a stage's ask at the stage's end; runs never ask", () => {
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

  it("the turn that ends the stage leaves exactly ONE owed slot the pod raised, no turn dispatched; the answer wakes a run turn told the next stage; the next turn end completes", async () => {
    const { sessionId, channelId, runId } = await seedRun(WEEKLY_STAGES);

    // ── the turn ends: the pod asks, the run waits ────────────────────────
    const r = await completeRun(sessionId, COMPLETED("turn-1"));
    expect(r).toEqual({ code: 200, json: { status: "waiting_on_you" } });
    const run = await runRow(runId);
    expect(run.status).toBe("waiting_on_you");
    expect(run.completed_at).toBeNull();
    const slots = await owed(sessionId);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "decision",
      label: LABEL,
      owner: "human",
      blockedReason: "decision",
      why: "The weekly review is listed above.",
      unblocks: "The run creates a task for each priority",
      ask: { mode: "choose", options: PRIORITIES_ASK.options },
    });
    // The other declared slot is untouched.
    expect(
      (await sessionRow(sessionId)).expected_outputs.map((s) => s.label)
    ).toEqual(["Findings", LABEL]);
    // No turn was dispatched: nobody but the person moves next.
    expect(h.triggers).toHaveLength(0);
    // ONE question in the room, filed on the slot, as the run's agent.
    const asked = await questions(channelId);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.role).toBe("assistant");
    expect(asked[0]!.metadata).toMatchObject({
      roomPost: { kind: "question", slotLabel: LABEL },
    });
    // Asked once per run: the ledger names the stage.
    expect((await ledger(sessionId)).stageAsks).toEqual(["review"]);
    // The pod never moves the step on the person's behalf.
    expect((await sessionRow(sessionId)).current_stage).toBe("collect");

    // ── the person answers through the real door: a RUN turn wakes ─────────
    const answered = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      value: {
        type: "chip",
        chip: {
          label: "The three the review recommends",
          value: "recommended",
        },
      },
    });
    expect(answered).toMatchObject({ status: "answered", triggered: true });
    expect(h.triggers).toHaveLength(1);
    const woke = h.triggers[0]!;
    expect(woke).toMatchObject({
      channelId,
      focusSessionId: sessionId,
      agentType: "researcher",
      // The run's declared tools: the woken turn is a RUN turn.
      run: { verbs: ["postiz_schedule_post"] },
    });
    const entries = (woke.turnContext as { entries: unknown[] }).entries;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "run.stageAsk.answered" }),
        { key: "run.stageAsk.chosenValue", value: "recommended" },
        { key: "run.stageAsk.nextStage", value: "Plan" },
        {
          key: "run.stageAsk.nextGoal",
          value: "Create a task for each priority the person chose.",
        },
      ])
    );
    expect(
      String(
        (entries as Array<{ key: string; value: string }>).find(
          (e) => e.key === "run.stageAsk.answered"
        )!.value
      )
    ).toContain("Review");
    // The turn context stays inside the turn-context contract.
    expect(TurnContextSchema.safeParse({ entries }).success).toBe(true);

    // ── the woken turn ends: nothing left to ask, the run completes ───────
    const done = await completeRun(sessionId, COMPLETED("turn-2"));
    expect(done.json).toEqual({ status: "completed" });
    expect((await runRow(runId)).status).toBe("completed");
    expect(await questions(channelId)).toHaveLength(1);
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
  });

  it("a RETRIED report of the turn that parked the run never completes it under the person", async () => {
    const { sessionId, runId } = await seedRun(WEEKLY_STAGES);
    await completeRun(sessionId, COMPLETED("turn-r"));
    const again = await completeRun(sessionId, COMPLETED("turn-r"));
    expect(again.json).toEqual({ status: "duplicate" });
    expect((await runRow(runId)).status).toBe("waiting_on_you");
    expect(await owed(sessionId)).toHaveLength(1);
  });

  it("a run whose stages declare NO ask completes exactly as before: no slot, no question", async () => {
    const plain = WEEKLY_STAGES.map((s) =>
      Object.fromEntries(Object.entries(s).filter(([k]) => k !== "endAsk"))
    );
    const { sessionId, channelId, runId } = await seedRun(plain);
    const r = await completeRun(sessionId, COMPLETED("turn-p"));
    expect(r.json).toEqual({ status: "completed" });
    expect((await runRow(runId)).status).toBe("completed");
    expect(await owed(sessionId)).toHaveLength(0);
    expect(await questions(channelId)).toHaveLength(0);
    expect((await ledger(sessionId)).stageAsks).toBeUndefined();
  });

  it("an ask behind a GATE the run has not entered waits for the gate; at the gated stage it is raised", async () => {
    const gated = [
      { key: "draft", name: "Draft", category: "planned" },
      {
        key: "send",
        name: "Send",
        category: "started",
        gate: { kind: "human" },
        endAsk: {
          label: "Signed contract",
          ask: { mode: "provide", provide: { kind: "file" } },
        },
      },
      { key: "active", name: "Active", category: "completed" },
    ];
    const before = await seedRun(gated);
    expect(
      (await completeRun(before.sessionId, COMPLETED("g-1"))).json
    ).toEqual({ status: "completed" });
    expect(await owed(before.sessionId)).toHaveLength(0);

    const at = await seedRun(gated, { currentStage: "send" });
    expect((await completeRun(at.sessionId, COMPLETED("g-2"))).json).toEqual({
      status: "waiting_on_you",
    });
    const slots = await owed(at.sessionId);
    expect(slots).toHaveLength(1);
    // A file only the person holds: a `provide`, blocked on the physical world.
    expect(slots[0]).toMatchObject({
      kind: "file",
      label: "Signed contract",
      blockedReason: "physical",
      ask: { mode: "provide", provide: { kind: "file" } },
    });
  });

  it("a choose that reads its options from the subject: none found is not asked (once per run); found ones come first", async () => {
    const asset = randomUUID();
    const stages = [
      {
        key: "draft",
        name: "Draft",
        category: "started",
        endAsk: {
          label: "Variant to keep",
          ask: {
            mode: "choose",
            options: [{ label: "None: draft again", value: "redo" }],
          },
          optionsFrom: { relation: "derived_from" },
        },
      },
      { key: "approve", name: "Approve", category: "completed" },
    ];
    await q(
      `insert into entities (id, user_id, title, created_at, updated_at) values ($1, $2, 'Logo', now(), now())`,
      [asset, OWNER]
    );

    // No variant yet: nothing to choose among, the run completes.
    const none = await seedRun(stages, { subjectEntityId: asset });
    expect((await completeRun(none.sessionId, COMPLETED("v-1"))).json).toEqual({
      status: "completed",
    });
    expect(await owed(none.sessionId)).toHaveLength(0);

    // Two variants derived from the asset: they are the options, newest first.
    const older = randomUUID();
    const newer = randomUUID();
    for (const [id, title, at] of [
      [older, "Logo, round", "2026-11-09T10:00:00Z"],
      [newer, "Logo, square", "2026-11-09T11:00:00Z"],
    ] as const) {
      await q(
        `insert into entities (id, user_id, title, created_at, updated_at) values ($1, $2, $3, now(), now())`,
        [id, OWNER, title]
      );
      await q(
        `insert into relations (id, user_id, source_entity_id, target_entity_id, type, created_at) values ($1, $2, $3, $4, 'derived_from', $5)`,
        [randomUUID(), OWNER, id, asset, at]
      );
    }
    const some = await seedRun(stages, { subjectEntityId: asset });
    expect((await completeRun(some.sessionId, COMPLETED("v-2"))).json).toEqual({
      status: "waiting_on_you",
    });
    const slots = await owed(some.sessionId);
    expect(slots).toHaveLength(1);
    expect((slots[0]!.ask as { options: unknown[] }).options).toEqual([
      { label: "Logo, square", value: newer },
      { label: "Logo, round", value: older },
      { label: "None: draft again", value: "redo" },
    ]);
  });

  it("an ask that does NOT land leaves the run live and un-records the stage, so the next turn end asks again", async () => {
    const { sessionId, runId } = await seedRun(WEEKLY_STAGES);
    h.failDeclare = true;
    const r = await completeRun(sessionId, COMPLETED("f-1"));
    expect(r.json).toEqual({ status: "left_running" });
    expect((await runRow(runId)).status).toBe("running");
    expect((await ledger(sessionId)).stageAsks).toEqual([]);
    h.failDeclare = false;
    const again = await completeRun(sessionId, COMPLETED("f-2"));
    expect(again.json).toEqual({ status: "waiting_on_you" });
    expect(await owed(sessionId)).toHaveLength(1);
  });
});
