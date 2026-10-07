/**
 * W2 typed asks — the answer / attest / ask-about doors, driven through the
 * REAL services (and the real Hub answer route) and read back out of PGlite.
 *
 *   - ANSWER: a typed value is validated against the slot's ask with the ONE
 *     rule — an unoffered chip is refused (`ask_invalid:`), a stale
 *     `askFingerprint` is refused (`ask_changed:`), and a refusal leaves NO
 *     message in the room. A valid chip is stored as the OFFERED copy on
 *     `answer.value`, the room post says the summary, the event carries the
 *     value. A form's secret-shaped value is REDACTED in the slot, the room
 *     post and the event.
 *   - ATTEST: "I did this" also posts "Done: <label>" as the person, emits
 *     `focus_session.slot_attested.completed`, and wakes the pod-run agent
 *     through `triggerAutoRespond` exactly once; it is refused on a slot whose
 *     ask wants an ANSWER, leaving no receipt and no wake.
 *   - ASK ABOUT: a seed anchored `session_slot` in the session room + one turn
 *     carrying the resolved slot; owner-only; idempotent under double-tap.
 *   - LEGACY (no ask): answer and attest keep today's stored shape.
 *
 * Harness copied from `answer-loop.pglite.test.ts` (same stubs, same reasons).
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
  effects: [] as Array<Record<string, unknown>>,
  triggers: [] as Array<Record<string, unknown>>,
  /** Make the answer door's post-commit steps throw (best-effort tail). */
  failPost: false,
  failWake: false,
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
        // The reach rule reads `dispatched_via` binding edges.
        links: actual.links as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (p: Record<string, unknown>) => {
      h.effects.push(p);
    },
  };
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
    if (h.failWake) throw new Error("pg-boss is down");
    h.triggers.push(p);
    return true;
  },
}));
vi.mock("../../messaging/post-message.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../messaging/post-message.js")>();
  return {
    ...actual,
    postChannelMessage: async (
      p: Parameters<typeof actual.postChannelMessage>[0]
    ) => {
      if (h.failPost && p.idempotencyKey?.startsWith("slot-answer:")) {
        throw new Error("room insert failed");
      }
      return actual.postChannelMessage(p);
    },
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
  links,
  governanceRules,
} from "@synap/database";
import { FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE } from "../lifecycle-events.js";
import { answerExpectedOutput } from "../answer-slot.js";
import {
  answerSessionSlot,
  attestSessionSlot,
  attestReceiptText,
} from "../session-answer.js";
import { askAboutSlot } from "../ask-about-slot.js";
import { FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE } from "../lifecycle-events.js";
import {
  askFingerprint,
  askRefusalIsStale,
  ASK_CHANGED_PREFIX,
  ASK_INVALID_PREFIX,
} from "@synap-core/types/ask";
import { REDACTED_SECRET } from "@synap-core/types/vault";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { registerThreadsRoutes } from "../../../routers/hub-protocol/rest/threads.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const IS_AGENT = "22222222-2222-4222-8222-222222222222";
const EXT_AGENT = "44444444-4444-4444-8444-444444444444";

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

const LABEL = "Stripe key";
const WHY = "Which Stripe account — EU or US?";

type Slot = Record<string, unknown> & {
  label: string;
  answer?: Record<string, unknown>;
};
const slotsOf = async (sessionId: string): Promise<Slot[]> =>
  (
    await q<{ expected_outputs: Slot[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs;
const slot = async (sessionId: string, label = LABEL) =>
  (await slotsOf(sessionId)).find((s) => s.label === label)!;
function app(opts: { userId?: string; agentUserId?: string } = {}) {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, (opts.userId ?? OWNER) as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    if (opts.agentUserId) {
      c.set("agentUserId" as never, opts.agentUserId as never);
    }
    await next();
  });
  registerThreadsRoutes(a as never);
  registerFocusSessionsRoutes(a as never);
  return a;
}
const send = (
  a: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown
) =>
  a.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const IDLE = "DNS record";

async function seedAsk(
  ask: Record<string, unknown> | null,
  opts: { agentIds?: string[] } = {}
): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Ship billing', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  const slots = [
    {
      kind: "document",
      label: LABEL,
      owner: "human",
      blockedReason: "decision",
      why: WHY,
      owedSince: "2026-09-25T09:00:00.000Z",
      ...(ask ? { ask } : {}),
    },
    { kind: "document", label: IDLE },
  ];
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship billing', 'Ship billing', 'active', $3::jsonb, $4, '{}'::jsonb, '[]'::jsonb, $5, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      JSON.stringify(slots),
      opts.agentIds ?? [IS_AGENT],
      channelId,
    ]
  );
  return { sessionId, channelId };
}

const roomMessages = async (channelId: string) =>
  (
    await q<{
      id: string;
      content: string;
      metadata: Record<string, unknown> | null;
      message_category: string | null;
    }>(
      `select id, content, metadata, message_category from messages where channel_id = $1 order by timestamp asc`,
      [channelId]
    )
  ).rows;

const CHOOSE = {
  mode: "choose",
  options: [
    {
      label: "EU account",
      value: "eu",
      recommended: true,
      description: "→ bills in EUR",
    },
    { label: "US account", value: "us" },
  ],
};
const FORM = {
  mode: "form",
  form: {
    fields: [{ key: "notes", label: "Notes", type: "text", required: true }],
  },
};
const SECRET = "sk_live_DO_NOT_STORE_123";

const answer = (
  sessionId: string,
  body: Record<string, unknown>,
  opts: { agentUserId?: string } = {}
) =>
  send(app(opts), "POST", `/focus-sessions/${sessionId}/outputs/answer`, {
    expectedLabel: LABEL,
    ...body,
  });

describe("W2 typed ask doors", () => {
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
      governanceRules,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'o@example.test', 'Other', 'UTC', 'human', null),
        ($3, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher'),
        ($4, 'c@example.test', 'Claude Code', 'UTC', 'agent', 'claude-code')`,
      [OWNER, OTHER, IS_AGENT, EXT_AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
    h.triggers.length = 0;
    h.failPost = false;
    h.failWake = false;
  });

  // ── update (Hub PATCH — the IS door) ───────────────────────────────────────

  it("Hub PATCH says back an ask it dropped on a slot that is not the person's (warnings[])", async () => {
    const { sessionId } = await seedAsk(null);
    const res = await send(app(), "PATCH", `/focus-sessions/${sessionId}`, {
      expectedOutputs: [
        {
          kind: "document",
          label: IDLE,
          ask: { mode: "confirm", prompt: "Ship it?" },
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      warnings?: string[];
      expectedOutputs?: Array<{ label: string; ask?: unknown }>;
    };
    const idle = body.expectedOutputs?.find((o) => o.label === IDLE);
    expect(idle?.ask).toBeUndefined();
    expect(body.warnings?.length).toBe(1);
    expect(body.warnings?.[0]).toContain(IDLE);
  });

  // ── answer ────────────────────────────────────────────────────────────────

  it("refuses an option that was not offered — 400 ask_invalid:, nothing posted, slot untouched", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const res = await answer(sessionId, {
      value: { type: "chip", chip: { label: "Asia account", value: "asia" } },
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error.startsWith(ASK_INVALID_PREFIX)).toBe(true);
    expect(askRefusalIsStale(error)).toBe(false);
    expect(await roomMessages(channelId)).toHaveLength(0);
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
    expect(h.triggers).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("refuses free text on a closed choose (no allowOther)", async () => {
    const { sessionId } = await seedAsk(CHOOSE);
    const res = await answer(sessionId, { text: "whatever works" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^ask_invalid:/
    );
  });

  it("refuses a stale fingerprint — 409 ask_changed:, nothing posted", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const res = await answer(sessionId, {
      value: { type: "chip", chip: { label: "EU account", value: "eu" } },
      askFingerprint: askFingerprint({ mode: "confirm" }),
    });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error.startsWith(ASK_CHANGED_PREFIX)).toBe(true);
    expect(askRefusalIsStale(error)).toBe(true);
    expect(await roomMessages(channelId)).toHaveLength(0);
    expect((await slot(sessionId)).answer).toBeUndefined();
  });

  it("refuses at the LOCK when the ask changed after the door's read (the race half)", async () => {
    const { sessionId } = await seedAsk(CHOOSE);
    const result = await answerExpectedOutput({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      text: "EU account",
      messageId: null,
      askFingerprint: askFingerprint({ mode: "confirm" }),
    });
    expect(result.status).toBe("ask_changed");
    expect((await slot(sessionId)).answer).toBeUndefined();
  });

  it("a valid chip: the OFFERED copy on answer.value, the summary in the room, the value on the event, one wake", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const res = await answer(sessionId, {
      // A client restyling the option cannot change what is stored.
      value: {
        type: "chip",
        chip: { label: "EU account", value: "eu", description: "forged" },
      },
      text: "we invoice in EUR",
      askFingerprint: askFingerprint(CHOOSE as never),
    });
    expect(res.status).toBe(200);
    const s = await slot(sessionId);
    const stored = s.answer as { text: string; value: Record<string, unknown> };
    expect(stored.value).toEqual({ type: "chip", chip: CHOOSE.options[0] });
    expect(stored.text).toBe("EU account — we invoice in EUR");
    expect(s.owner).toBeUndefined(); // handed back
    const room = await roomMessages(channelId);
    expect(room.map((m) => m.content)).toEqual([
      "EU account — we invoice in EUR",
    ]);
    const [event] = h.events;
    expect(event!.type).toBe(FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE);
    expect(event!.data.value).toEqual({
      type: "chip",
      chip: CHOOSE.options[0],
    });
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]!.agentType).toBe("researcher");
    // The poll door returns the typed value too.
    const page = await send(
      app(),
      "GET",
      `/focus-sessions/${sessionId}/answers`
    );
    const body = (await page.json()) as { answers: Array<{ value: unknown }> };
    expect(body.answers[0]!.value).toEqual({
      type: "chip",
      chip: CHOOSE.options[0],
    });
  });

  it("a form's secret-shaped value is REDACTED in the slot, the room post and the event", async () => {
    const { sessionId, channelId } = await seedAsk(FORM);
    const res = await answer(sessionId, {
      value: {
        type: "form",
        values: { notes: { kind: "new", value: SECRET } },
      },
    });
    expect(res.status).toBe(200);
    const s = await slot(sessionId);
    expect(JSON.stringify(s.answer)).not.toContain(SECRET);
    expect(JSON.stringify(s.answer)).toContain(REDACTED_SECRET);
    const room = await roomMessages(channelId);
    expect(room).toHaveLength(1);
    expect(room[0]!.content).not.toContain(SECRET);
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    expect(JSON.stringify(h.effects)).not.toContain(SECRET);
    expect(JSON.stringify(h.triggers)).not.toContain(SECRET);
  });

  it("the service redacts even when a caller hands it an UNPARSED value (door-independent)", async () => {
    const { sessionId, channelId } = await seedAsk(FORM);
    const result = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      value: {
        type: "form",
        values: { notes: { kind: "new", value: SECRET } },
      } as never,
    });
    expect(result.status).toBe("answered");
    expect(JSON.stringify(await slot(sessionId))).not.toContain(SECRET);
    expect(JSON.stringify(await roomMessages(channelId))).not.toContain(SECRET);
  });

  it("an agent key still cannot answer (403)", async () => {
    const { sessionId } = await seedAsk(CHOOSE);
    const res = await answer(
      sessionId,
      { value: { type: "confirm", confirmed: true } },
      { agentUserId: IS_AGENT }
    );
    expect(res.status).toBe(403);
  });

  it("LEGACY: an ask-less slot takes free text and stores no value — today's shape", async () => {
    const { sessionId, channelId } = await seedAsk(null);
    const res = await answer(sessionId, { text: "EU" });
    expect(res.status).toBe(200);
    const s = await slot(sessionId);
    const stored = s.answer as Record<string, unknown>;
    expect(stored.text).toBe("EU");
    expect("value" in stored).toBe(false);
    expect((await roomMessages(channelId)).map((m) => m.content)).toEqual([
      "EU",
    ]);
    expect(h.events[0]!.data.value).toBeNull();
    // A typed value on an ask-less slot is refused, never silently dropped.
    const { sessionId: other } = await seedAsk(null);
    const typed = await answer(other, {
      value: { type: "confirm", confirmed: true },
    });
    expect(typed.status).toBe(400);
  });

  it("a confirm's PROMPT is stored as the question, not the slot's why", async () => {
    const PROMPT = "Ship on Friday?";
    const { sessionId } = await seedAsk({ mode: "confirm", prompt: PROMPT });
    const res = await answer(sessionId, {
      value: { type: "confirm", confirmed: true },
    });
    expect(res.status).toBe(200);
    const stored = (await slot(sessionId)).answer as { question?: string };
    expect(stored.question).toBe(PROMPT);
    // Without a prompt the why stays the question (today's shape).
    const { sessionId: bare } = await seedAsk({ mode: "confirm" });
    await answer(bare, { value: { type: "confirm", confirmed: false } });
    expect(((await slot(bare)).answer as { question?: string }).question).toBe(
      WHY
    );
  });

  // ── attest ────────────────────────────────────────────────────────────────

  it("attest: done + receipt as the person + one event + ONE wake through triggerAutoRespond", async () => {
    const ACT = { mode: "act", url: "https://dashboard.stripe.com/apikeys" };
    const { sessionId, channelId } = await seedAsk(ACT);
    const result = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(result.status).toBe("attested");
    const s = await slot(sessionId);
    expect(s.status).toBe("done");
    expect(s.attestedBy).toBe(OWNER);
    const room = await roomMessages(channelId);
    expect(room.map((m) => m.content)).toEqual([attestReceiptText(LABEL)]);
    const attested = h.events.filter(
      (e) => e.type === FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE
    );
    expect(attested).toHaveLength(1);
    expect(attested[0]!.data.askMode).toBe("act");
    expect(h.effects.filter((e) => e.action === "slot_attested")).toHaveLength(
      1
    );
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({
      channelId,
      userMessageId: room[0]!.id,
      sourceUserId: OWNER,
      focusSessionId: sessionId,
      agentType: "researcher",
    });
  });

  it("attest is REFUSED on a slot whose ask wants an answer — no stamp, no receipt, no wake", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const result = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(result.status).toBe("answer_required");
    expect((await slot(sessionId)).status).toBeUndefined();
    expect(await roomMessages(channelId)).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("LEGACY: an ask-less human slot attests exactly as before (done, attestedBy, owner kept)", async () => {
    const { sessionId } = await seedAsk(null);
    const result = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(result.status).toBe("attested");
    const s = await slot(sessionId);
    expect(s).toMatchObject({
      status: "done",
      attestedBy: OWNER,
      owner: "human",
    });
  });

  it("attest on a session with no pod-run agent wakes nobody (the receipt still lands)", async () => {
    const { sessionId, channelId } = await seedAsk(null, { agentIds: [] });
    const result = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(result).toMatchObject({
      status: "attested",
      triggered: false,
      wokeAgentType: null,
    });
    expect(await roomMessages(channelId)).toHaveLength(1);
    expect(h.triggers).toHaveLength(0);
  });

  // ── ask about it ──────────────────────────────────────────────────────────

  it("askAboutSlot: an anchored seed in the session room + ONE turn carrying the resolved slot", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const result = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      note: "Which one do we use today?",
    });
    expect(result).toMatchObject({
      status: "asked",
      channelId,
      seeded: true,
      triggered: true,
    });
    if (result.status !== "asked") throw new Error("not asked");
    expect(result.threadId).toBe(result.messageId);
    const room = await roomMessages(channelId);
    expect(room).toHaveLength(1);
    expect(room[0]!.id).toBe(result.messageId);
    expect(room[0]!.content).toBe(
      `Tell me more about "${LABEL}". What exactly do you need from me?\n\nWhich one do we use today?`
    );
    expect(room[0]!.message_category).toBe("comment");
    expect(room[0]!.metadata?.anchor).toEqual({
      kind: "session_slot",
      sessionId,
      label: LABEL,
      askFingerprint: askFingerprint(CHOOSE as never),
    });
    expect(h.triggers).toHaveLength(1);
    const trig = h.triggers[0]!;
    expect(trig.agentType).toBe("researcher");
    const anchor = (trig.turnContext as { anchor: Record<string, unknown> })
      .anchor;
    expect(anchor.resolution).toBe("slot_resolved");
    expect(anchor.slot).toMatchObject({
      label: LABEL,
      owner: "human",
      why: WHY,
      askChanged: false,
      ask: { mode: "choose" },
    });
    // The slot itself is untouched — asking is not answering.
    expect((await slot(sessionId)).owner).toBe("human");
  });

  it("askAboutSlot is idempotent under double-tap — one seed; a re-tap re-triggers THAT seed's turn", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const a = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    const b = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(b).toMatchObject({ status: "asked", seeded: false });
    expect(b.status === "asked" && b.messageId).toBe(
      a.status === "asked" && a.messageId
    );
    expect(await roomMessages(channelId)).toHaveLength(1);
    // Every turn is keyed on the ONE seed (`singletonKey` collapses a queued
    // or running job; a dropped one is finally run).
    expect(h.triggers.length).toBeGreaterThanOrEqual(1);
    expect(new Set(h.triggers.map((t) => t.userMessageId))).toEqual(
      new Set([a.status === "asked" && a.messageId])
    );
  });

  it("askAboutSlot keys idempotency on the ANCHOR — an unrelated message in between does not mint a second seed", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const a = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    // The person says something else in the room (no open question: no answer).
    await send(app(), "POST", `/threads/${channelId}/messages`, {
      role: "user",
      content: "also, the invoice template is in Drive",
      userId: OWNER,
    });
    const b = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(b).toMatchObject({ status: "asked", seeded: false });
    expect(b.status === "asked" && b.messageId).toBe(
      a.status === "asked" && a.messageId
    );
    const seeds = (await roomMessages(channelId)).filter(
      (m) => m.metadata?.anchor
    );
    expect(seeds).toHaveLength(1);
  });

  it("askAboutSlot opens a NEW thread once the agent replied to the last one", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const a = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    const reply = await send(
      app({ agentUserId: IS_AGENT }),
      "POST",
      `/threads/${channelId}/messages`,
      { role: "assistant", content: "EU bills in EUR.", userId: OWNER }
    );
    expect(reply.status).toBe(200);
    const b = await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(b).toMatchObject({ status: "asked", seeded: true });
    expect(b.status === "asked" && b.messageId).not.toBe(
      a.status === "asked" && a.messageId
    );
  });

  it("askAboutSlot under CONCURRENT taps posts one seed", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        askAboutSlot({ sessionId, userId: OWNER, expectedLabel: LABEL })
      )
    );
    const ids = new Set(
      results.map((r) => (r.status === "asked" ? r.messageId : null))
    );
    expect(ids.size).toBe(1);
    expect(
      results.filter((r) => r.status === "asked" && r.seeded)
    ).toHaveLength(1);
    expect(await roomMessages(channelId)).toHaveLength(1);
    expect(new Set(h.triggers.map((t) => t.userMessageId))).toEqual(ids);
  });

  it("askAboutSlot stamps the RENDERED ask's fingerprint, so the turn sees CHANGED", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const rendered = askFingerprint({ mode: "confirm" });
    await askAboutSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      askFingerprint: rendered,
    });
    const [seed] = await roomMessages(channelId);
    expect(
      (seed!.metadata?.anchor as { askFingerprint: string }).askFingerprint
    ).toBe(rendered);
    const anchor = (
      h.triggers[0]!.turnContext as {
        anchor: { slot: { askChanged: boolean } };
      }
    ).anchor;
    expect(anchor.slot.askChanged).toBe(true);
  });

  it("askAboutSlot is OWNER-only — another person gets not_found and nothing is posted", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    expect(
      await askAboutSlot({ sessionId, userId: OTHER, expectedLabel: LABEL })
    ).toEqual({ status: "not_found" });
    expect(await roomMessages(channelId)).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
  });

  // ── the answer door's order + best-effort tail ───────────────────────────

  it("a refusal AT THE LOCK leaves no answer in the room (race through answerSessionSlot)", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const pick = () =>
      answerSessionSlot({
        sessionId,
        userId: OWNER,
        expectedLabel: LABEL,
        value: { type: "chip", chip: { label: "EU account", value: "eu" } },
        askFingerprint: askFingerprint(CHOOSE as never),
      });
    const results = await Promise.all([pick(), pick()]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "answered",
      "ask_changed",
    ]);
    const room = await roomMessages(channelId);
    expect(room).toHaveLength(1);
    expect((await slot(sessionId)).answer?.messageId).toBe(room[0]!.id);
  });

  it("a failed wake after commit still returns the answer (never a 500 on a committed answer)", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    h.failWake = true;
    const result = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      value: { type: "chip", chip: { label: "EU account", value: "eu" } },
    });
    expect(result).toMatchObject({ status: "answered", triggered: false });
    expect((await slot(sessionId)).answer).toBeDefined();
    expect(await roomMessages(channelId)).toHaveLength(1);
  });

  it("a failed room post after commit still returns the answer, with no message id and no wake", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    h.failPost = true;
    const result = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      value: { type: "chip", chip: { label: "EU account", value: "eu" } },
    });
    expect(result).toMatchObject({
      status: "answered",
      messageId: null,
      triggered: false,
    });
    expect((await slot(sessionId)).answer).toBeDefined();
    expect(await roomMessages(channelId)).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
  });

  // ── a room reply against a TYPED ask ─────────────────────────────────────

  const agentQuestion = async (channelId: string) => {
    const res = await send(
      app({ agentUserId: IS_AGENT }),
      "POST",
      `/threads/${channelId}/messages`,
      {
        role: "assistant",
        content: WHY,
        userId: OWNER,
        kind: "question",
        slotLabel: LABEL,
      }
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { messageId: string }).messageId;
  };
  const ownerReply = async (channelId: string, content: string) => {
    const res = await send(app(), "POST", `/threads/${channelId}/messages`, {
      role: "user",
      content,
      userId: OWNER,
    });
    expect(res.status).toBe(200);
  };
  const questionAnswer = async (id: string) =>
    (
      (
        await q<{ metadata: Record<string, { answer?: unknown }> }>(
          `select metadata from messages where id = $1`,
          [id]
        )
      ).rows[0]!.metadata.roomPost as { answer?: unknown }
    ).answer;

  it("words in the room do NOT answer a closed choose — the question is answered, the slot stays owed", async () => {
    const { sessionId, channelId } = await seedAsk(CHOOSE);
    const qid = await agentQuestion(channelId);
    await ownerReply(channelId, "the EU one I guess");
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
    expect(await questionAnswer(qid)).toBeDefined();
    expect(
      h.events.filter((e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE)
    ).toHaveLength(0);
    // The asker still hears the reply to its question.
    expect(h.triggers).toHaveLength(1);
  });

  it("a choose WITH allowOther takes the words as its typed text answer", async () => {
    const { sessionId, channelId } = await seedAsk({
      ...CHOOSE,
      allowOther: true,
    });
    await agentQuestion(channelId);
    await ownerReply(channelId, "the APAC account");
    const s = await slot(sessionId);
    expect(s.owner).toBeUndefined();
    expect(s.answer).toMatchObject({
      text: "the APAC account",
      value: { type: "text" },
    });
  });

  it("a follow-up inside an 'ask about it' thread never hands the slot back (even a legacy slot)", async () => {
    const { sessionId, channelId } = await seedAsk(null);
    await askAboutSlot({ sessionId, userId: OWNER, expectedLabel: LABEL });
    const qid = await agentQuestion(channelId);
    await ownerReply(channelId, "ok so EU then?");
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
    expect(await questionAnswer(qid)).toBeDefined();
  });
});
