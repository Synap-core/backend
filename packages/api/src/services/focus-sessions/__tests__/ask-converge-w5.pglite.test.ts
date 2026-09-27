/**
 * W5 typed asks — converge the server-minted slots onto the ask, and PROVIDE.
 * Driven through the REAL services (and the real Hub post route) against
 * PGlite.
 *
 *   - PARAM: a missing required param is owed with its typed ask + `paramName`,
 *     and ANSWERING it writes the value into the run's params
 *     (`metadata.params`) in the same write as the answer — coerced by the run
 *     funnel's own rule; a value that is not the param's type is refused
 *     before anything is posted.
 *   - CRITERION: an escalated criterion's pass/fail answer reaches THE grade
 *     door — a human evaluation row, the slot discharged — and "I did this" on
 *     it is refused like any other answer-shaped ask.
 *   - PROVIDE: a reference is checked against the row behind it — the
 *     answerer's own secret / a usable connection / a visible file — and a
 *     plaintext credential never parses, never posts, never stores.
 *   - ROOM QUESTION: an agent's `question` with a `slotLabel` is filed ON the
 *     slot (owner human, why = the question, ask = the one passed); a slotless
 *     question files nothing.
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
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  triggers: [] as Array<Record<string, unknown>>,
  visibleFiles: new Set<string>(),
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
        sessionEvaluations: actual.sessionEvaluations as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
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
  logEvent: async (
    _userId: string,
    type: string,
    data: Record<string, unknown>
  ) => {
    h.events.push({ type, data });
    return "evt";
  },
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.triggers.push(p);
    return true;
  },
}));
// The FILE floor is `isOutputRefVisible` (its own suite proves the access
// rules); here only WHETHER the answer door consults it matters.
vi.mock("../assert-output-ref-visible.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isOutputRefVisible: async (p: { refId: string }) =>
      h.visibleFiles.has(p.refId),
  };
});

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
  sessionEvaluations,
} from "@synap/database";
import { secrets, entities } from "@synap/database/schema";
import type { PlaybookParam } from "@synap/playbooks";
import {
  PARAM_SLOT_KIND,
  CRITERION_SLOT_KIND,
} from "@synap-core/types/focus-sessions";
import { answerSessionSlot, attestSessionSlot } from "../session-answer.js";
import { paramOwedSlots } from "../param-slots.js";
import { selectSlotToAttest } from "../satisfy-expected-output.js";
import { CRITERION_SLOT_ASK } from "../evaluations/record.js";
import { gradeCriterionAsOwner } from "../evaluations/evaluate.js";
import { postChannelMessage } from "../../messaging/post-message.js";
import { registerThreadsRoutes } from "../../../routers/hub-protocol/rest/threads.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
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

type Slot = Record<string, unknown> & { label: string };
const rowOf = async (sessionId: string) =>
  (
    await q<{
      expected_outputs: Slot[];
      metadata: Record<string, unknown>;
      status: string;
    }>(
      `select expected_outputs, metadata, status from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;
const slotOf = async (sessionId: string, label: string) =>
  (await rowOf(sessionId)).expected_outputs.find((s) => s.label === label)!;
const roomMessages = async (channelId: string) =>
  (
    await q<{ id: string; content: string }>(
      `select id, content from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows;

async function seed(
  slots: unknown[],
  opts: { criteria?: unknown[]; metadata?: Record<string, unknown> } = {}
): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Outreach', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Outreach', 'Outreach', 'active', $3::jsonb, $4, $5::jsonb, $6::jsonb, $7, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      JSON.stringify(slots),
      [IS_AGENT],
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.criteria ?? []),
      channelId,
    ]
  );
  return { sessionId, channelId };
}

const PARAMS: PlaybookParam[] = [
  {
    name: "channel",
    label: "Channel",
    type: "choice",
    options: ["email", "linkedin"],
    required: true,
  },
  { name: "budget", label: "Budget", type: "number", required: true },
  { name: "dryRun", label: "Dry run", type: "boolean", required: true },
];
const paramSlots = () =>
  paramOwedSlots(PARAMS, "Personalized Outreach", "2026-09-27T09:00:00.000Z");

const SECRET = "sk_live_DO_NOT_STORE_123";

describe("W5 — param / criterion / provide / room question on the ONE answer door", () => {
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
      sessionEvaluations,
      secrets,
      entities,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'o@example.test', 'Other', 'UTC', 'human', null),
        ($3, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher')`,
      [OWNER, OTHER, IS_AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    h.triggers.length = 0;
    h.visibleFiles.clear();
  });

  // ── param slots ─────────────────────────────────────────────────────────

  it("a missing param is owed with its typed ask and its machine name", () => {
    const [channel, budget, dryRun] = paramSlots();
    expect(channel).toMatchObject({
      kind: PARAM_SLOT_KIND,
      paramName: "channel",
      owner: "human",
      blockedReason: "decision",
      ask: {
        mode: "choose",
        options: [
          { label: "email", value: "email" },
          { label: "linkedin", value: "linkedin" },
        ],
      },
    });
    expect(budget!.ask).toEqual({
      mode: "form",
      form: {
        fields: [
          { key: "budget", label: "Budget", type: "number", required: true },
        ],
      },
    });
    expect(dryRun!.ask).toEqual({ mode: "confirm" });
  });

  it("answering a param slot writes the value into metadata.params, typed, beside what was already there", async () => {
    const { sessionId } = await seed(paramSlots(), {
      metadata: { params: { tone: "warm" }, prompt: "keep me" },
    });
    const chip = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Answer: Channel",
      value: { type: "chip", chip: { label: "linkedin", value: "linkedin" } },
    });
    expect(chip.status).toBe("answered");
    const form = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Answer: Budget",
      // A form posts a number as a string — coerced by the run funnel's rule.
      value: { type: "form", values: { budget: "1200" } },
    });
    expect(form.status).toBe("answered");
    const yes = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Answer: Dry run",
      value: { type: "confirm", confirmed: false },
    });
    expect(yes.status).toBe("answered");

    const row = await rowOf(sessionId);
    expect(row.metadata).toEqual({
      prompt: "keep me",
      params: {
        tone: "warm",
        channel: "linkedin",
        budget: 1200,
        dryRun: false,
      },
    });
    // Still the ordinary answer: handed back to the agent with the answer on it.
    const slot = await slotOf(sessionId, "Answer: Budget");
    expect(slot.owner).toBeUndefined();
    expect((slot.answer as { text: string }).text).toBe("Budget: 1200");
  });

  it("a value that is not the param's type is refused BEFORE anything is posted or written", async () => {
    const { sessionId, channelId } = await seed(paramSlots());
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Answer: Budget",
      value: { type: "form", values: { budget: "lots" } },
    });
    expect(r).toMatchObject({ status: "ask_invalid", code: "invalid_field" });
    expect(await roomMessages(channelId)).toHaveLength(0);
    const row = await rowOf(sessionId);
    expect(row.metadata).toEqual({});
    expect((await slotOf(sessionId, "Answer: Budget")).owner).toBe("human");
  });

  it("a param slot filed before paramName existed is answered as words and writes no param", async () => {
    const legacy = { ...paramSlots()[1]! };
    delete legacy.paramName;
    delete legacy.ask;
    const { sessionId } = await seed([legacy]);
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Answer: Budget",
      text: "about 1200",
    });
    expect(r.status).toBe("answered");
    expect((await rowOf(sessionId)).metadata).toEqual({});
  });

  // ── criterion slots ─────────────────────────────────────────────────────

  const CRITERIA = [
    {
      key: "no-stale",
      statement: "No stale numbers",
      required: true,
      check: { kind: "human" },
    },
  ];
  const criterionSlot = () => ({
    kind: CRITERION_SLOT_KIND,
    label: "Check: No stale numbers",
    criterionKey: "no-stale",
    status: "pending",
    owner: "human",
    blockedReason: "decision",
    why: 'Checked 2 times and still not passing — mark "No stale numbers" pass or fail.',
    owedSince: "2026-09-27T09:00:00.000Z",
    ask: CRITERION_SLOT_ASK,
  });

  it("a criterion slot's pass/fail answer reaches THE grade door and discharges the slot", async () => {
    const { sessionId } = await seed([criterionSlot()], { criteria: CRITERIA });
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Check: No stale numbers",
      value: { type: "chip", chip: { label: "Fail", value: "fail" } },
      text: "Q2 revenue is from March",
    });
    expect(r.status).toBe("answered");
    if (r.status !== "answered") return;
    expect(r.graded).toEqual({
      verdict: "fail",
      recorded: true,
      resumed: false,
    });
    expect(r.handedBack).toBe(false);

    const evals = (
      await q<{ verdict: string; evaluator_kind: string; rationale: string }>(
        `select verdict, evaluator_kind, rationale from session_evaluations where session_id = $1`,
        [sessionId]
      )
    ).rows;
    expect(evals).toEqual([
      {
        verdict: "fail",
        evaluator_kind: "human",
        rationale: "Q2 revenue is from March",
      },
    ]);
    const slot = await slotOf(sessionId, "Check: No stale numbers");
    expect(slot.status).toBe("done");
    expect(slot.attestedBy).toBe(OWNER);
    expect((slot.answer as { text: string }).text).toBe(
      "Fail — Q2 revenue is from March"
    );
  });

  it("the scorecard's grade door discharges a criterion slot that carries the pass/fail ask", async () => {
    const { sessionId } = await seed([criterionSlot()], { criteria: CRITERIA });
    const { out } = await gradeCriterionAsOwner({
      sessionId,
      userId: OWNER,
      criterionKey: "no-stale",
      verdict: "pass",
    });
    expect(out.status).toBe("recorded");
    expect((await slotOf(sessionId, "Check: No stale numbers")).status).toBe(
      "done"
    );
  });

  it("'I did this' on a criterion slot is refused — a grade is an answer, not a done", async () => {
    const { sessionId } = await seed([criterionSlot()], { criteria: CRITERIA });
    const r = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Check: No stale numbers",
    });
    expect(r.status).toBe("answer_required");
  });

  it("the grade exception is CRITERION-only: any other answer-shaped slot still refuses attest", () => {
    const confirmSlot = {
      kind: "document",
      label: "Region",
      owner: "human" as const,
      ask: { mode: "confirm" as const },
    };
    expect(
      selectSlotToAttest([confirmSlot], "Region", { criterionGraded: true })
    ).toEqual({ refused: "answer_required" });
    expect(
      selectSlotToAttest(
        [criterionSlot() as never],
        "Check: No stale numbers",
        {
          criterionGraded: true,
        }
      )
    ).toEqual({ index: 0 });
  });

  it("a criterion no longer declared is refused before posting", async () => {
    const { sessionId, channelId } = await seed([criterionSlot()]);
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Check: No stale numbers",
      value: { type: "chip", chip: { label: "Pass", value: "pass" } },
    });
    expect(r).toMatchObject({ status: "ask_invalid", code: "invalid_field" });
    expect(await roomMessages(channelId)).toHaveLength(0);
  });

  // ── provide ─────────────────────────────────────────────────────────────

  const provideSlot = (provide: Record<string, unknown>) => ({
    kind: "document",
    label: "Stripe key",
    owner: "human",
    blockedReason: "credential",
    why: "The restricted key for the live account",
    owedSince: "2026-09-27T09:00:00.000Z",
    ask: { mode: "provide", provide },
  });
  async function seedSecret(p: {
    userId: string;
    capabilityId?: string;
    isPodWide?: boolean;
    deleted?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag, encryption_mode, capability_id, is_pod_wide, deleted_at, is_favorite, access_count, has_totp, is_shared, is_default, auth_fail_count, encryption_version, created_at, updated_at)
       values ($1, $2, 'STRIPE_KEY', 'api_key', 'x', 'x', 'x', 'server', $3, $4, $5, false, 0, false, false, false, 0, 1, now(), now())`,
      [
        id,
        p.userId,
        p.capabilityId ?? null,
        p.isPodWide ?? false,
        p.deleted ? new Date().toISOString() : null,
      ]
    );
    return id;
  }

  it("provide(secret): the answerer's own vault secret is accepted — the ref is stored, never shown", async () => {
    const id = await seedSecret({ userId: OWNER });
    const { sessionId, channelId } = await seed([
      provideSlot({ kind: "secret", name: "STRIPE_KEY" }),
    ]);
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Stripe key",
      value: {
        type: "provide",
        ref: { kind: "secret", vaultRef: `vault://${id}` },
      },
    });
    expect(r.status).toBe("answered");
    const slot = await slotOf(sessionId, "Stripe key");
    const answer = slot.answer as { text: string; value: unknown };
    expect(answer.value).toEqual({
      type: "provide",
      ref: { kind: "secret", vaultRef: `vault://${id}` },
    });
    expect(answer.text).toBe('Stored the secret "STRIPE_KEY" in the vault');
    expect(JSON.stringify(await roomMessages(channelId))).not.toContain(id);
  });

  it("provide(secret): someone else's / a deleted secret is refused, nothing posted, ref never echoed", async () => {
    for (const id of [
      await seedSecret({ userId: OTHER }),
      await seedSecret({ userId: OWNER, deleted: true }),
      // Pod-wide is shared substrate, not "yours to hand over".
      await seedSecret({ userId: OTHER, isPodWide: true }),
    ]) {
      const { sessionId, channelId } = await seed([
        provideSlot({ kind: "secret", name: "STRIPE_KEY" }),
      ]);
      const r = await answerSessionSlot({
        sessionId,
        userId: OWNER,
        expectedLabel: "Stripe key",
        value: {
          type: "provide",
          ref: { kind: "secret", vaultRef: `vault://${id}` },
        },
      });
      expect(r).toMatchObject({
        status: "ask_invalid",
        code: "provide_unreachable",
      });
      expect(JSON.stringify(r)).not.toContain(id);
      expect(await roomMessages(channelId)).toHaveLength(0);
      expect((await slotOf(sessionId, "Stripe key")).answer).toBeUndefined();
    }
  });

  it("provide: a PLAINTEXT credential where a reference belongs never parses — no post, no slot, no event carries it", async () => {
    for (const ref of [
      { kind: "secret", vaultRef: SECRET },
      { kind: "connection", connectionId: SECRET },
    ]) {
      const { sessionId, channelId } = await seed([
        provideSlot(
          ref.kind === "secret"
            ? { kind: "secret", name: "STRIPE_KEY" }
            : { kind: "connection", service: "stripe" }
        ),
      ]);
      const r = await answerSessionSlot({
        sessionId,
        userId: OWNER,
        expectedLabel: "Stripe key",
        value: { type: "provide", ref } as never,
      });
      expect(r.status).toBe("ask_invalid");
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(await roomMessages(channelId)).toHaveLength(0);
      expect(JSON.stringify(await rowOf(sessionId))).not.toContain(SECRET);
      expect(JSON.stringify(h.events)).not.toContain(SECRET);
    }
  });

  it("provide(connection): own or pod-wide connection accepted; another member's private one, or a plain secret, refused", async () => {
    const cap = randomUUID();
    const own = await seedSecret({ userId: OWNER, capabilityId: cap });
    const shared = await seedSecret({
      userId: OTHER,
      capabilityId: cap,
      isPodWide: true,
    });
    const foreign = await seedSecret({ userId: OTHER, capabilityId: cap });
    const notAConnection = await seedSecret({ userId: OWNER });
    const tryIt = async (connectionId: string) => {
      const { sessionId } = await seed([
        provideSlot({ kind: "connection", service: "gmail" }),
      ]);
      return answerSessionSlot({
        sessionId,
        userId: OWNER,
        expectedLabel: "Stripe key",
        value: { type: "provide", ref: { kind: "connection", connectionId } },
      });
    };
    const ok = await tryIt(own);
    expect(ok.status).toBe("answered");
    expect(ok.status === "answered" && ok.answer.text).toBe("Connected Gmail");
    expect((await tryIt(shared)).status).toBe("answered");
    expect(await tryIt(foreign)).toMatchObject({ code: "provide_unreachable" });
    expect(await tryIt(notAConnection)).toMatchObject({
      code: "provide_unreachable",
    });
  });

  it("provide(file): a visible file is attached BY NAME; an invisible one is refused", async () => {
    const fileId = randomUUID();
    await q(`insert into entities (id, title) values ($1, 'Q3 deck.pdf')`, [
      fileId,
    ]);
    const { sessionId, channelId } = await seed([
      provideSlot({ kind: "file" }),
    ]);
    const hidden = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Stripe key",
      value: { type: "provide", ref: { kind: "file", fileId } },
    });
    expect(hidden).toMatchObject({ code: "provide_unreachable" });
    h.visibleFiles.add(fileId);
    const shown = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Stripe key",
      value: { type: "provide", ref: { kind: "file", fileId } },
    });
    expect(shown.status).toBe("answered");
    expect((await roomMessages(channelId)).map((m) => m.content)).toEqual([
      'Attached "Q3 deck.pdf"',
    ]);
  });

  // ── room question → slot ask ────────────────────────────────────────────

  function hub() {
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
    registerThreadsRoutes(a as never);
    return a;
  }
  const hubPost = (channelId: string, body: Record<string, unknown>) =>
    hub().request(`/threads/${channelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "assistant", userId: OWNER, ...body }),
    });

  const AGENT_SLOT = { kind: "document", label: "Region" };
  const CONFIRM = { mode: "confirm" };

  it("Hub: an agent's question about a slot is filed ON it — owner human, why = the question, ask = the one passed", async () => {
    const { sessionId, channelId } = await seed([AGENT_SLOT]);
    const res = await hubPost(channelId, {
      content: "Bill the EU entity?",
      kind: "question",
      slotLabel: "Region",
      ask: CONFIRM,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { slot?: unknown }).slot).toEqual({
      status: "blocked",
    });
    const slot = await slotOf(sessionId, "Region");
    expect(slot).toMatchObject({
      owner: "human",
      blockedReason: "decision",
      why: "Bill the EU entity?",
      ask: CONFIRM,
    });
    // …and the answer lands on the slot (the SSOT), through the answer door.
    const answered = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: "Region",
      value: { type: "confirm", confirmed: true },
    });
    expect(answered.status).toBe("answered");
    expect(answered.status === "answered" && answered.questionId).toBeTruthy();
  });

  it("MCP door (postChannelMessage): same filing; no ask ⇒ a free-text slot", async () => {
    const { sessionId, channelId } = await seed([AGENT_SLOT]);
    const r = await postChannelMessage({
      channelId,
      content: "Which region should we bill?",
      role: "assistant",
      triggerAI: false,
      kind: "question",
      slotLabel: "region",
      userId: OWNER,
      agentUserId: IS_AGENT,
    });
    expect(r.slot).toEqual({ status: "blocked" });
    const slot = await slotOf(sessionId, "Region");
    expect(slot.owner).toBe("human");
    expect(slot.why).toBe("Which region should we bill?");
    expect(slot.ask).toBeUndefined();
  });

  it("a slotless question, an update, and an unknown slot file nothing", async () => {
    const { sessionId, channelId } = await seed([AGENT_SLOT]);
    const plain = await postChannelMessage({
      channelId,
      content: "Any preference?",
      role: "assistant",
      triggerAI: false,
      kind: "question",
      userId: OWNER,
      agentUserId: IS_AGENT,
    });
    expect(plain.slot).toBeUndefined();
    const unknown = await postChannelMessage({
      channelId,
      content: "What about this?",
      role: "assistant",
      triggerAI: false,
      kind: "question",
      slotLabel: "Nope",
      userId: OWNER,
      agentUserId: IS_AGENT,
    });
    expect(unknown.slot).toEqual({ status: "unknown_label" });
    expect((await slotOf(sessionId, "Region")).owner).toBeUndefined();
  });

  it("Hub: an ask without a slot question is refused before anything is written", async () => {
    const { channelId } = await seed([AGENT_SLOT]);
    const res = await hubPost(channelId, {
      content: "Bill the EU entity?",
      kind: "update",
      ask: CONFIRM,
    });
    expect(res.status).toBe(400);
    expect(await roomMessages(channelId)).toHaveLength(0);
  });
});
