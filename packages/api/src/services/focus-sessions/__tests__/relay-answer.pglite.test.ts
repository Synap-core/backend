/**
 * THE RELAY DOOR (Resolve-XP W1), driven through the REAL Hub doors and read
 * back out of PGlite.
 *
 *   - an agent relays the person's chat words to the EXACT question it asked
 *     (`POST /focus-sessions/:id/answers/relay`): a ROUTINE ask is answered,
 *     stamped `via: 'relayed'` + `relayedBy` + `quote` on the slot AND the
 *     room question, its decision filed with the relay recorded, nobody woken;
 *   - a COMMITMENT is not answered: `pendingRelay` on the slot and the
 *     question, the slot still owed (and its needs-you row carries the relay),
 *     no event, no decision, no wake;
 *   - the person's Confirm (`/outputs/answer` `confirmRelayed`) records the
 *     relay as THEIR tap (`via: 'tap'` + `confirmedAt`, relay kept);
 *   - "Not what I said" (`rejectRelayed`) drops a pending relay, or undoes an
 *     unconfirmed routine relay (archived, re-asked), on a slot or a slotless
 *     question, and emits ONE `focus_session.relay_corrected.completed`;
 *   - withdraw closes the agent's own question and hands its slot back;
 *   - who may relay: only the asker, only an agent key, only an exact
 *     address; and `/outputs/unblock` refuses an agent key.
 *
 * Stubbed, and why — the same seams as `answer-loop.pglite.test.ts`: transport
 * (Expo, sockets), channel visibility (its own suite), the event history row +
 * reactor hop (CAPTURED), `triggerAutoRespond` (CAPTURED: "nobody woken" is
 * asserted on it), and the decision entity door (CAPTURED: the decision's
 * fields are what is under test, its writes have their own suites).
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
  decisions: [] as Array<Record<string, unknown>>,
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
vi.mock("../../decisions/decision-entity-door.js", () => ({
  createDecisionEntity: async (
    _scope: unknown,
    input: Record<string, unknown>
  ) => {
    h.decisions.push(input);
    return "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  },
  updateDecisionEntity: async () => undefined,
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
import {
  FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
} from "../lifecycle-events.js";
import { projectOwedSlots } from "../owed-outputs.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import { registerThreadsRoutes } from "../../../routers/hub-protocol/rest/threads.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

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

const LABEL = "Stripe account";
const WHY = "Which Stripe account bills EU customers?";
const CHOOSE = {
  mode: "choose",
  options: [
    { label: "EU account", value: "eu", recommended: true },
    { label: "US account", value: "us" },
  ],
};
const DEPLOY = { mode: "confirm", prompt: "Deploy to prod?", stakes: "commitment" };
const EU = { type: "chip", chip: { label: "EU account", value: "eu" } };

async function seed(): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Billing', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Billing', 'Billing', 'active', $3::jsonb, $4, '{}'::jsonb, '[]'::jsonb, $5, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      JSON.stringify([{ kind: "document", label: LABEL }]),
      [AGENT],
      channelId,
    ]
  );
  return { sessionId, channelId };
}

type Slot = Record<string, unknown> & {
  label: string;
  answer?: Record<string, unknown>;
  pendingRelay?: Record<string, unknown>;
};
const slot = async (sessionId: string): Promise<Slot> =>
  (
    await q<{ expected_outputs: Slot[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs.find((s) => s.label === LABEL)!;
const roomPost = async (messageId: string) =>
  (
    (
      await q<{ metadata: { roomPost?: Record<string, unknown> } | null }>(
        `select metadata from messages where id = $1`,
        [messageId]
      )
    ).rows[0]!.metadata ?? {}
  ).roomPost ?? {};

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
  path: string,
  body: unknown
) =>
  a.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The agent's question, through the Hub door; with an ask it is filed ON the slot. */
async function ask(
  channelId: string,
  extra: Record<string, unknown> = {},
  agent = AGENT
): Promise<string> {
  const res = await send(
    app({ agentUserId: agent }),
    `/threads/${channelId}/messages`,
    {
      role: "assistant",
      content: WHY,
      userId: OWNER,
      kind: "question",
      ...extra,
    }
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { messageId: string }).messageId;
}
const relay = (sessionId: string, body: Record<string, unknown>, agent = AGENT) =>
  send(app({ agentUserId: agent }), `/focus-sessions/${sessionId}/answers/relay`, body);
const personAnswer = (sessionId: string, body: Record<string, unknown>) =>
  send(app(), `/focus-sessions/${sessionId}/outputs/answer`, body);

const answered = () =>
  h.events.filter((e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE);
const corrected = () =>
  h.events.filter((e) => e.type === FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE);

describe("the relay door", () => {
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
        ($2, 'c@example.test', 'Claude Code', 'UTC', 'agent', 'claude-code'),
        ($3, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher')`,
      [OWNER, AGENT, OTHER_AGENT]
    );
    // An external agent: it holds its own door key (never woken by the pod).
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3)`,
      [randomUUID(), AGENT, OWNER]
    );
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
    h.triggers.length = 0;
    h.decisions.length = 0;
  });

  it("ROUTINE: answers the slot and its question, marked relayed; files the decision with the relay; wakes nobody", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: CHOOSE });
    const res = await relay(sessionId, {
      disposition: "answered",
      messageId: qid,
      quote: "the EU one obviously",
      value: EU,
      relaySurface: "claude-code",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "relayed",
      stakes: "routine",
      questionId: qid,
      expectedLabel: LABEL,
    });

    const s = await slot(sessionId);
    expect(s.owner).toBeUndefined(); // handed back to the agent
    expect(s.answer).toMatchObject({
      answeredBy: OWNER,
      messageId: qid,
      value: EU,
      via: "relayed",
      relayedBy: AGENT,
      relaySurface: "claude-code",
      quote: "the EU one obviously",
    });
    expect(s.answer!.confirmedAt).toBeUndefined();
    expect((await roomPost(qid)).answer).toMatchObject({
      via: "relayed",
      relayedBy: AGENT,
      quote: "the EU one obviously",
    });
    expect(answered()).toHaveLength(1);
    expect(answered()[0]!.data).toMatchObject({ via: "relayed", relayedBy: AGENT });
    // The decision door is reached with the relay recorded.
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]!.properties).toMatchObject({
      chosenOption: "eu",
      answeredVia: "relayed",
      relayedBy: AGENT,
      relayQuote: "the EU one obviously",
    });
    expect(h.triggers).toHaveLength(0);
  });

  it("COMMITMENT: never answers, never unblocks, never files, never wakes — it waits for the tap, and the needs-you row carries it", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: DEPLOY });
    const res = await relay(sessionId, {
      disposition: "answered",
      slotLabel: LABEL,
      quote: "yes ship it",
      value: { type: "confirm", confirmed: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "awaiting_tap",
      stakes: "commitment",
      questionId: qid,
    });
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
    expect(s.pendingRelay).toMatchObject({
      relayedBy: AGENT,
      quote: "yes ship it",
      value: { type: "confirm", confirmed: true },
    });
    const post = await roomPost(qid);
    expect(post.answer).toBeUndefined();
    expect(post.pendingRelay).toMatchObject({ relayedBy: AGENT });
    expect(answered()).toHaveLength(0);
    expect(h.decisions).toHaveLength(0);
    expect(h.triggers).toHaveLength(0);
    // The owed row a tray renders: the one-tap Confirm rides on it.
    const [row] = projectOwedSlots({
      id: sessionId,
      goal: "Billing",
      status: "active",
      workspaceId: null,
      projectId: null,
      expectedOutputs: [s],
    });
    expect(row!.pendingRelay).toMatchObject({ relayedBy: AGENT });

    // A second relay over it is refused: the tap is still owed.
    const again = await relay(sessionId, {
      disposition: "answered",
      slotLabel: LABEL,
      quote: "yes",
      value: { type: "confirm", confirmed: true },
    });
    expect(again.status).toBe(409);
  });

  it("CONFIRM: the person's tap records the relay as theirs — via tap + confirmedAt, the relay kept", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: DEPLOY });
    await relay(sessionId, {
      disposition: "answered",
      messageId: qid,
      quote: "yes ship it",
      value: { type: "confirm", confirmed: true },
    });
    const res = await personAnswer(sessionId, {
      expectedLabel: LABEL,
      confirmRelayed: true,
    });
    expect(res.status).toBe(200);
    const s = await slot(sessionId);
    expect(s.pendingRelay).toBeUndefined();
    expect(s.owner).toBeUndefined();
    expect(s.answer).toMatchObject({
      answeredBy: OWNER,
      value: { type: "confirm", confirmed: true },
      via: "tap",
      relayedBy: AGENT,
      quote: "yes ship it",
    });
    expect(typeof s.answer!.confirmedAt).toBe("string");
    const post = await roomPost(qid);
    expect(post.pendingRelay).toBeUndefined();
    expect(post.answer).toMatchObject({ via: "tap", relayedBy: AGENT });
    expect(answered()).toHaveLength(1);
    expect(h.decisions[0]!.properties).toMatchObject({
      answeredVia: "tap",
      relayedBy: AGENT,
    });

    // Nothing pending any more: a second Confirm is refused, said.
    const twice = await personAnswer(sessionId, {
      expectedLabel: LABEL,
      confirmRelayed: true,
    });
    expect(twice.status).toBe(400);
  });

  it("NOT WHAT I SAID on a pending relay: dropped from slot and question, the slot still owed, ONE correction event", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: DEPLOY });
    await relay(sessionId, {
      disposition: "answered",
      messageId: qid,
      quote: "yes",
      value: { type: "confirm", confirmed: true },
    });
    const res = await personAnswer(sessionId, {
      expectedLabel: LABEL,
      rejectRelayed: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "corrected",
      dropped: "pending",
      relayedBy: AGENT,
    });
    const s = await slot(sessionId);
    expect(s.pendingRelay).toBeUndefined();
    expect(s.owner).toBe("human");
    expect((await roomPost(qid)).pendingRelay).toBeUndefined();
    expect(corrected()).toHaveLength(1);
    expect(corrected()[0]!.data).toMatchObject({
      relayedBy: AGENT,
      dropped: "pending",
    });
  });

  it("NOT WHAT I SAID on a routine relay: archived, the slot re-asked to the person, the question open again", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: CHOOSE });
    await relay(sessionId, {
      disposition: "answered",
      messageId: qid,
      quote: "the EU one",
      value: EU,
    });
    const res = await personAnswer(sessionId, {
      expectedLabel: LABEL,
      rejectRelayed: true,
    });
    expect(res.status).toBe(200);
    const s = await slot(sessionId);
    expect(s.answer).toBeUndefined();
    expect(s.owner).toBe("human");
    expect((s.ask as { mode?: string }).mode).toBe("choose");
    expect(s.answerHistory).toEqual([
      expect.objectContaining({ via: "relayed", relayedBy: AGENT }),
    ]);
    expect((await roomPost(qid)).answer).toBeUndefined();
    expect(corrected()).toHaveLength(1);

    // A TAP is never undone this way.
    await personAnswer(sessionId, { expectedLabel: LABEL, value: EU });
    const tap = await personAnswer(sessionId, {
      expectedLabel: LABEL,
      rejectRelayed: true,
    });
    expect(tap.status).toBe(400);
    expect((await slot(sessionId)).answer).toMatchObject({ value: EU });
  });

  it("SLOTLESS question: always routine; corrected by questionId", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId);
    const res = await relay(sessionId, {
      disposition: "answered",
      messageId: qid,
      quote: "Tuesday works",
    });
    expect(await res.json()).toMatchObject({ status: "relayed", stakes: "routine" });
    expect((await roomPost(qid)).answer).toMatchObject({
      text: "Tuesday works",
      answeredBy: OWNER,
      via: "relayed",
      relayedBy: AGENT,
    });
    const fix = await personAnswer(sessionId, {
      questionId: qid,
      rejectRelayed: true,
    });
    expect(fix.status).toBe(200);
    expect((await roomPost(qid)).answer).toBeUndefined();
    expect(corrected()).toHaveLength(1);
  });

  it("WITHDRAW: closes the agent's own question with its note, hands the slot back — never retires it", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, {
      slotLabel: LABEL,
      ask: { mode: "provide", provide: { kind: "connection", service: "stripe" } },
    });
    const res = await relay(sessionId, {
      disposition: "withdrawn",
      messageId: qid,
      note: "found the key in the vault",
    });
    expect(await res.json()).toMatchObject({
      status: "withdrawn",
      questionId: qid,
      handedBack: true,
    });
    expect((await roomPost(qid)).closed).toMatchObject({
      reason: "withdrawn",
      by: AGENT,
      note: "found the key in the vault",
    });
    const s = await slot(sessionId);
    expect(s.owner).toBeUndefined();
    expect(s.retiredAt).toBeUndefined();
    expect(s.status).toBeUndefined();
  });

  it("WHO and WHICH: an exact address, the asker only, an agent key only; quote and note required", async () => {
    const { sessionId, channelId } = await seed();
    const qid = await ask(channelId, { slotLabel: LABEL, ask: CHOOSE });
    const base = { disposition: "answered", quote: "EU", value: EU };
    // No address: never "the newest open question".
    expect((await relay(sessionId, base)).status).toBe(400);
    // Another agent's question.
    expect(
      (await relay(sessionId, { ...base, messageId: qid }, OTHER_AGENT)).status
    ).toBe(403);
    // A person's key cannot relay.
    expect(
      (await send(app(), `/focus-sessions/${sessionId}/answers/relay`, {
        ...base,
        messageId: qid,
      })).status
    ).toBe(403);
    // Words required, verbatim; a withdraw needs its reason.
    expect(
      (await relay(sessionId, { disposition: "answered", messageId: qid, value: EU }))
        .status
    ).toBe(400);
    expect(
      (await relay(sessionId, { disposition: "withdrawn", messageId: qid })).status
    ).toBe(400);
    // Nothing moved.
    const s = await slot(sessionId);
    expect(s.owner).toBe("human");
    expect(s.answer).toBeUndefined();
  });

  it("an AGENT key can never write a tap: the answer door refuses it, Confirm included", async () => {
    const { sessionId, channelId } = await seed();
    await ask(channelId, { slotLabel: LABEL, ask: DEPLOY });
    await relay(sessionId, {
      disposition: "answered",
      slotLabel: LABEL,
      quote: "yes",
      value: { type: "confirm", confirmed: true },
    });
    const res = await send(
      app({ agentUserId: AGENT }),
      `/focus-sessions/${sessionId}/outputs/answer`,
      { expectedLabel: LABEL, confirmRelayed: true }
    );
    expect(res.status).toBe(403);
    expect((await slot(sessionId)).answer).toBeUndefined();
  });

  it("/outputs/unblock refuses an agent key; the person's \"Not mine\" still works", async () => {
    const { sessionId, channelId } = await seed();
    await ask(channelId, { slotLabel: LABEL, ask: CHOOSE });
    const asAgent = await send(
      app({ agentUserId: AGENT }),
      `/focus-sessions/${sessionId}/outputs/unblock`,
      { expectedLabel: LABEL }
    );
    expect(asAgent.status).toBe(403);
    expect((await slot(sessionId)).owner).toBe("human");
    const asPerson = await send(
      app(),
      `/focus-sessions/${sessionId}/outputs/unblock`,
      { expectedLabel: LABEL }
    );
    expect(asPerson.status).toBe(200);
    expect((await slot(sessionId)).owner).toBeUndefined();
  });
});
