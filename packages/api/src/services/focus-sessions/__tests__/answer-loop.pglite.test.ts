/**
 * THE ANSWER LOOP (M5 + M3 + poll door), driven through the REAL doors and
 * read back out of PGlite.
 *
 *   - an agent's `kind:'question'` + `slotLabel` is PERSISTED on the message
 *     (MCP `postChannelMessage`, Hub `POST /threads/:id/messages`), and a
 *     client cannot forge the marker;
 *   - the session OWNER's plain reply in the room (Hub `POST /threads/:id/
 *     messages`, human key) resolves that slot — handed back to the agent with
 *     `answer`, status untouched — marks the question answered, emits ONE
 *     `focus_session.slot_answered.completed`, and wakes the asking pod-run
 *     agent through `triggerAutoRespond` with its agent type named;
 *   - the direct door (Hub `POST /focus-sessions/:id/outputs/answer`) lands
 *     the SAME answer + event + wake, and posts the answer into the room;
 *   - a NON-owner's reply does nothing; an external asker (owns a door key) is
 *     never woken; a session with no pod-run agent wakes nobody; an agent key
 *     cannot answer;
 *   - the poll door (`GET /focus-sessions/:id/answers`) honours `since`
 *     (exclusive), the owner floor, and merges a slot answer with the question
 *     it closed into ONE item.
 *
 * Real: both Hub route modules (parsing, acting context, reply shaping), the
 * services under test, the tables. Stubbed, and why: Expo + the socket bridge
 * (no transport), the channel visibility predicate (its own suite — this file
 * pins who ANSWERS, not who may post), the message event append, the event
 * history row + the reactor hop (CAPTURED — "one event" is asserted on them),
 * and `triggerAutoRespond` (CAPTURED at the door — pg-boss + IS resolution are
 * its own suite; the call and its named agent are what is under test).
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
} from "@synap/database";
import { postChannelMessage } from "../../messaging/post-message.js";
import { FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE } from "../lifecycle-events.js";
import { recordOwnerRoomReply } from "../session-answer.js";
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

async function seed(
  opts: { agentIds?: string[]; blocked?: boolean } = {}
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
    opts.blocked === false
      ? { kind: "document", label: LABEL }
      : {
          kind: "document",
          label: LABEL,
          owner: "human",
          blockedReason: "decision",
          why: WHY,
          owedSince: "2026-09-25T09:00:00.000Z",
        },
    { kind: "document", label: "DNS record" },
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
const metaOf = async (messageId: string) =>
  (
    await q<{ metadata: Record<string, unknown> | null }>(
      `select metadata from messages where id = $1`,
      [messageId]
    )
  ).rows[0]!.metadata;

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

/** An agent's question through the Hub door (an agent key). */
async function hubQuestion(
  channelId: string,
  agent: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await send(
    app({ agentUserId: agent }),
    "POST",
    `/threads/${channelId}/messages`,
    {
      role: "assistant",
      content: WHY,
      userId: OWNER,
      kind: "question",
      slotLabel: LABEL,
      ...extra,
    }
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { messageId: string }).messageId;
}

/** A human's plain reply through the Hub door (no agent key). */
async function hubReply(
  channelId: string,
  content: string,
  userId = OWNER
): Promise<string> {
  const res = await send(
    app({ userId }),
    "POST",
    `/threads/${channelId}/messages`,
    { role: "user", content, userId }
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { messageId: string }).messageId;
}

const answeredEvents = () =>
  h.events.filter((e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE);
/** The reactor hops for THIS event (other doors emit their own side effects). */
const answeredEffects = () =>
  h.effects.filter((e) => e.action === "slot_answered");

describe("the answer loop", () => {
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
    // The external agent authenticates with its OWN door key.
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3)`,
      [randomUUID(), EXT_AGENT, OWNER]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
    h.triggers.length = 0;
  });

  // ── persistence ────────────────────────────────────────────────────────────

  it("MCP post_message: an agent question persists kind + slotLabel on the row", async () => {
    const { channelId } = await seed();
    const r = await postChannelMessage({
      channelId,
      content: WHY,
      userId: OWNER,
      agentUserId: IS_AGENT,
      kind: "question",
      slotLabel: `  ${LABEL} `,
    });
    expect(await metaOf(r.messageId)).toEqual({
      roomPost: { kind: "question", slotLabel: LABEL },
    });
  });

  it("Hub POST /threads: persists the question; a client-forged roomPost is dropped", async () => {
    const { channelId } = await seed();
    const qid = await hubQuestion(channelId, IS_AGENT);
    expect((await metaOf(qid))!.roomPost).toEqual({
      kind: "question",
      slotLabel: LABEL,
    });
    // A HUMAN key forging an answered question gets no marker at all.
    const res = await send(app(), "POST", `/threads/${channelId}/messages`, {
      role: "assistant",
      content: "fake",
      userId: OWNER,
      metadata: {
        roomPost: { kind: "question", answer: { messageId: "x" } },
        note: 1,
      },
    });
    const fake = ((await res.json()) as { messageId: string }).messageId;
    expect(await metaOf(fake)).toEqual({ note: 1 });
  });

  // ── M5 + M3 from the room ─────────────────────────────────────────────────

  it("the OWNER's room reply resolves the slot, marks the question, emits ONE event, wakes the asking agent", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await hubQuestion(channelId, IS_AGENT);
    const rid = await hubReply(channelId, "EU account, please");

    const s = await slot(sessionId);
    // Handed BACK to the agent (ownership quartet cleared), never "done".
    expect(s.owner).toBeUndefined();
    expect(s.blockedReason).toBeUndefined();
    expect(s.owedSince).toBeUndefined();
    expect(s.status).toBeUndefined();
    expect(s.answer).toMatchObject({
      text: "EU account, please",
      messageId: rid,
      answeredBy: OWNER,
      question: WHY,
    });
    // The sibling slot is untouched.
    expect(await slot(sessionId, "DNS record")).toEqual({
      kind: "document",
      label: "DNS record",
    });
    expect(
      ((await metaOf(qid))!.roomPost as { answer: unknown }).answer
    ).toMatchObject({ messageId: rid, answeredBy: OWNER });

    expect(answeredEvents()).toHaveLength(1);
    expect(answeredEvents()[0]!.data).toMatchObject({
      sessionId,
      expectedLabel: LABEL,
      handedBack: true,
      messageId: rid,
    });
    expect(answeredEffects()).toHaveLength(1);
    expect(answeredEffects()[0]).toMatchObject({
      subjectType: "focus_session",
      action: "slot_answered",
      subjectId: sessionId,
    });

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({
      channelId,
      userMessageId: rid,
      agentType: "researcher",
      focusSessionId: sessionId,
      sourceUserId: OWNER,
    });
  });

  it("a SECOND reply answers nothing — the question was answered once", async () => {
    const { sessionId, channelId } = await seed();
    await hubQuestion(channelId, IS_AGENT);
    const first = await hubReply(channelId, "EU");
    h.triggers.length = 0;
    h.events.length = 0;
    await hubReply(channelId, "thanks!");
    expect((await slot(sessionId)).answer).toMatchObject({ messageId: first });
    expect(answeredEvents()).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
  });

  it("a NON-owner's reply does nothing: slot still owed, question still open, no event, no wake", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await hubQuestion(channelId, IS_AGENT);
    await hubReply(channelId, "US, obviously", OTHER);
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
    expect(
      ((await metaOf(qid))!.roomPost as Record<string, unknown>).answer
    ).toBeUndefined();
    expect(answeredEvents()).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
  });

  it("an EXTERNAL asker (owns a door key) gets the answer recorded but is NOT woken", async () => {
    const { sessionId, channelId } = await seed({ agentIds: [EXT_AGENT] });
    await hubQuestion(channelId, EXT_AGENT);
    await hubReply(channelId, "EU");
    expect((await slot(sessionId)).answer).toMatchObject({ text: "EU" });
    expect(answeredEvents()).toHaveLength(1);
    expect(h.triggers).toHaveLength(0);
  });

  it("a slotless question: the reply is marked on the question and wakes the asker, no slot event", async () => {
    const { sessionId, channelId } = await seed();
    const res = await send(
      app({ agentUserId: IS_AGENT }),
      "POST",
      `/threads/${channelId}/messages`,
      {
        role: "assistant",
        content: "Ship today?",
        userId: OWNER,
        kind: "question",
      }
    );
    const qid = ((await res.json()) as { messageId: string }).messageId;
    const rid = await hubReply(channelId, "yes");
    expect(
      ((await metaOf(qid))!.roomPost as { answer: unknown }).answer
    ).toMatchObject({ messageId: rid, text: "yes" });
    expect((await slot(sessionId)).owner).toBe("human");
    expect(answeredEvents()).toHaveLength(0);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({ agentType: "researcher" });
  });

  it("wake:false (the send already starts a turn) records the answer but triggers nothing", async () => {
    const { sessionId, channelId } = await seed();
    await hubQuestion(channelId, IS_AGENT);
    const r = await recordOwnerRoomReply({
      channelId,
      messageId: randomUUID(),
      content: "EU",
      userId: OWNER,
      wake: false,
    });
    expect(r).toMatchObject({
      status: "answered",
      slot: "answered",
      woke: false,
    });
    expect((await slot(sessionId)).answer).toMatchObject({ text: "EU" });
    expect(h.triggers).toHaveLength(0);
  });

  // ── the direct door ──────────────────────────────────────────────────────

  it("the direct door lands the SAME answer + ONE event + the wake, and posts the answer into the room", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await hubQuestion(channelId, IS_AGENT);
    const res = await send(
      app(),
      "POST",
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: "stripe KEY", text: "EU account, please" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      expectedLabel: LABEL,
      handedBack: true,
      questionId: qid,
      wokeAgentType: "researcher",
      triggered: true,
    });
    const messageId = body.messageId as string;

    const s = await slot(sessionId);
    expect(s.owner).toBeUndefined();
    expect(s.status).toBeUndefined();
    expect(s.answer).toMatchObject({
      text: "EU account, please",
      messageId,
      answeredBy: OWNER,
      question: WHY,
    });
    const [posted] = (
      await q<{ content: string; author_type: string; role: string }>(
        `select content, author_type, role from messages where id = $1`,
        [messageId]
      )
    ).rows;
    expect(posted).toEqual({
      content: "EU account, please",
      author_type: "human",
      role: "user",
    });
    expect(
      ((await metaOf(qid))!.roomPost as { answer: unknown }).answer
    ).toMatchObject({ messageId });
    expect(answeredEvents()).toHaveLength(1);
    expect(answeredEffects()).toHaveLength(1);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({
      channelId,
      userMessageId: messageId,
      agentType: "researcher",
    });
  });

  it("the direct door with NO pod-run agent staffed and no question wakes nobody", async () => {
    const { sessionId } = await seed({ agentIds: [EXT_AGENT] });
    const res = await send(
      app(),
      "POST",
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: LABEL, text: "EU" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      wokeAgentType: null,
      triggered: false,
    });
    expect(h.triggers).toHaveLength(0);
    expect(answeredEvents()).toHaveLength(1);
  });

  it("an AGENT key cannot answer (403); a non-owner gets 404; a refusal posts nothing", async () => {
    const { sessionId, channelId } = await seed();
    const asAgent = await send(
      app({ agentUserId: IS_AGENT }),
      "POST",
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: LABEL, text: "ship it" }
    );
    expect(asAgent.status).toBe(403);
    const asOther = await send(
      app({ userId: OTHER }),
      "POST",
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: LABEL, text: "US" }
    );
    expect(asOther.status).toBe(404);
    const unknown = await send(
      app(),
      "POST",
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: "Nope", text: "US" }
    );
    expect(unknown.status).toBe(404);
    const count = (
      await q<{ n: number }>(
        `select count(*)::int as n from messages where channel_id = $1`,
        [channelId]
      )
    ).rows[0]!.n;
    expect(count).toBe(0);
    expect((await slot(sessionId)).owner).toBe("human");
  });

  // ── the poll door ────────────────────────────────────────────────────────

  it("GET /answers: one merged item per answer, since is exclusive, owner-floored", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await hubQuestion(channelId, IS_AGENT);
    const rid = await hubReply(channelId, "EU");
    // A slotless question answered afterwards.
    const res2 = await send(
      app({ agentUserId: IS_AGENT }),
      "POST",
      `/threads/${channelId}/messages`,
      {
        role: "assistant",
        content: "Ship today?",
        userId: OWNER,
        kind: "question",
      }
    );
    const q2 = ((await res2.json()) as { messageId: string }).messageId;
    await new Promise((r) => setTimeout(r, 5));
    const rid2 = await hubReply(channelId, "yes");

    const page = (await (
      await send(app(), "GET", `/focus-sessions/${sessionId}/answers`)
    ).json()) as {
      answers: Array<Record<string, unknown>>;
      nextSince: string;
      hasMore: boolean;
      since: string | null;
    };
    expect(page.since).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(page.answers.map((a) => a.id)).toEqual([rid, rid2]);
    expect(page.answers[0]).toMatchObject({
      text: "EU",
      messageId: rid,
      answeredBy: OWNER,
      slot: { label: LABEL, kind: "document", question: WHY },
      question: { messageId: qid, text: WHY, askedBy: IS_AGENT },
    });
    expect(page.answers[1]).toMatchObject({
      slot: null,
      question: { messageId: q2, text: "Ship today?" },
    });

    // Exclusive cursor: from the first answer's time, only the second remains.
    const after = (await (
      await send(
        app(),
        "GET",
        `/focus-sessions/${sessionId}/answers?since=${encodeURIComponent(page.answers[0]!.answeredAt as string)}`
      )
    ).json()) as { answers: Array<{ id: string }>; nextSince: string };
    expect(after.answers.map((a) => a.id)).toEqual([rid2]);
    // Nothing newer: an empty page echoes the cursor.
    const none = (await (
      await send(
        app(),
        "GET",
        `/focus-sessions/${sessionId}/answers?since=${encodeURIComponent(page.nextSince)}`
      )
    ).json()) as { answers: unknown[]; nextSince: string };
    expect(none.answers).toEqual([]);
    expect(none.nextSince).toBe(page.nextSince);

    // limit + hasMore.
    const one = (await (
      await send(app(), "GET", `/focus-sessions/${sessionId}/answers?limit=1`)
    ).json()) as { answers: Array<{ id: string }>; hasMore: boolean };
    expect(one.answers.map((a) => a.id)).toEqual([rid]);
    expect(one.hasMore).toBe(true);

    // Owner floor: another person sees nothing — 404, not an empty page.
    expect(
      (
        await send(
          app({ userId: OTHER }),
          "GET",
          `/focus-sessions/${sessionId}/answers`
        )
      ).status
    ).toBe(404);
    // A garbage cursor is a 400, never "from the beginning".
    expect(
      (
        await send(
          app(),
          "GET",
          `/focus-sessions/${sessionId}/answers?since=yesterday`
        )
      ).status
    ).toBe(400);
  });
});
