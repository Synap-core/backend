/**
 * Inbound into a person's channel (channels wave, lane C, design d00cd2ac
 * §1-3, §7): the REAL Unipile webhook route, the REAL recorder, the REAL
 * history import and the REAL identity resolver, compiled and run as SQL on
 * PGlite with the migration's own unique indexes (read from the baseline).
 * Only the provider (a fake connector), the queue and the side-effect fan-out
 * are stubbed; the fan-out is a spy so the automation events can be read.
 *
 * Rows rule out:
 *   - the webhook and the history import each landing one copy of the same
 *     message (the webhook hashed thread + time + body, the import its own);
 *   - the provider's echo of a message the pod sent landing a second row and
 *     firing `external_message.received` (an auto-reply answering ourselves);
 *   - an inbound reply after an outbound message carrying no `isReply`;
 *   - a second message from an unknown sender spending a second lookup;
 *   - the import firing automations (history replayed as news);
 *   - a provider id binding to the wrong person (another id, another
 *     provider's same id, a lookup with no match);
 *   - a person's pending channel (opened before any chat) getting a twin
 *     when the chat appears, instead of its chat id;
 *   - a receipt moving a delivery status backwards.
 *
 * Cannot see: a live Unipile account (payload shapes come from lane B's
 * fixtures), production Postgres, the pg-boss worker wiring.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  emitSideEffects: vi.fn(async (_p: unknown) => undefined),
  send: vi.fn(async (..._a: unknown[]) => "job-1"),
  connector: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: (p: unknown) => h.emitSideEffects(p),
  getBoss: () => ({ send: (...a: unknown[]) => h.send(...a) }),
  dispatchInboundDelivery: vi.fn(),
}));
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: (...a: unknown[]) => h.send(...a) }),
}));
vi.mock("@synap/jobs/workers/fireflies-worker.js", () => ({
  FIREFLIES_INGEST_QUEUE: "fireflies-ingest",
}));
vi.mock("@synap/jobs/workers/webhook-worker.js", () => ({
  liveApiKeyIds: async () => new Set<string>(),
  subscriptionKeyLive: () => true,
}));
vi.mock("../../connectors/index.js", () => ({
  getMessagingConnector: async () => h.connector,
}));
vi.mock("../channels/channel-origin.js", () => ({
  recordChannelOrigin: vi.fn(),
}));
vi.mock("../../utils/emit-message-observation.js", () => ({
  emitMessageObservation: vi.fn(),
}));
vi.mock("../intake/record-structure-intake.js", () => ({
  stageCaptureSources: vi.fn(),
}));
vi.mock("../capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: vi.fn(),
}));
vi.mock("../capture-agent/ensure-capture-agent.js", () => ({
  getCaptureAgentUserId: async () => null,
}));
vi.mock("../calcom/map-booking-to-graph.js", () => ({
  mapBookingToGraph: () => ({ entities: [], relations: [] }),
}));

import { SQL } from "drizzle-orm";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  extractIdentitySignals,
  registerIdentitySignals,
  db as pgDb,
} from "@synap/database";
import { webhooksInboundRouter } from "../../routers/webhooks-inbound.js";
import { runMessagingHistoryImport } from "./messaging-history-import.js";
import { openPersonChannel } from "./inbound-recorder.js";
import { PROFILE_LOOKUP_DAILY_CAP } from "./participant-lookup.js";

const dialect = new PgDialect();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable, withDefaults = true): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    const d = withDefaults ? (c.default as unknown) : undefined;
    if (c.primary && type === "uuid") def = " default gen_random_uuid()";
    else if (d instanceof SQL) {
      try {
        def = ` default ${dialect.sqlToQuery(d).sql}`;
      } catch {
        def = "";
      }
    } else if (d !== undefined) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

/** The migration's own unique indexes, as the baseline declares them. */
const BASELINE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../database/migrations/0000_baseline_schema.sql"
  ),
  "utf8"
);
function baselineIndex(name: string): string {
  const m = new RegExp(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${name}"[\\s\\S]*?;`
  ).exec(BASELINE);
  if (!m) throw new Error(`baseline has no index ${name}`);
  return m[0];
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const WS = randomUUID();
const ACC_ROW = randomUUID();
const IG_ROW = randomUUID();
const MARIE = randomUUID(); // carries her LinkedIn id
const PIERRE = randomUUID(); // carries only her LinkedIn URL
const LEAD = randomUUID(); // a lead with a pending channel

const T = (min: number) =>
  new Date(Date.UTC(2026, 10, 1, 10, min)).toISOString();

interface FakeMsg {
  externalMessageId: string;
  threadId: string;
  senderName: string;
  senderProviderId?: string;
  body: string;
  sentAt: string;
  direction: "inbound" | "outbound";
}
const profiles: Record<string, unknown> = {};
const conversations: Array<Record<string, unknown>> = [];
const chatMessages: Record<string, FakeMsg[]> = {};
const fake = {
  parseWebhook: async (_h: unknown, raw: string) => JSON.parse(raw),
  getProfile: vi.fn(async (_acc: string, id: string) => profiles[id] ?? null),
  // A chat id starting "group-" is a group chat (no single counterpart).
  getChat: vi.fn(async (_acc: string, chatId: string) => ({
    chatId,
    counterpart: chatId.startsWith("group-")
      ? null
      : {
          providerId: "ACoMarie",
          name: "Marie Curie",
          publicIdentifier: null,
        },
  })),
  getConversations: vi.fn(async () => ({ items: conversations })),
  getMessagesPage: vi.fn(async (_acc: string, chatId: string) => ({
    messages: chatMessages[chatId] ?? [],
  })),
  getAccounts: async () => [],
  ensureWebhooksRegistered: async () => undefined,
};

const app = new Hono();
app.route("/api/webhooks", webhooksInboundRouter);

function msg(
  chat: string,
  id: string,
  opts: Partial<FakeMsg> & { from?: string } = {}
): FakeMsg {
  return {
    externalMessageId: id,
    threadId: chat,
    senderName: opts.senderName ?? "Someone",
    senderProviderId: opts.from ?? opts.senderProviderId,
    body: opts.body ?? `body of ${id}`,
    sentAt: opts.sentAt ?? T(0),
    direction: opts.direction ?? "inbound",
  };
}

async function webhook(
  m: FakeMsg,
  account = { id: "acc-1", provider: "linkedin" }
): Promise<number> {
  const res = await app.request("/api/webhooks/messaging", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.created",
      accountExternalId: account.id,
      provider: account.provider,
      threadId: m.threadId,
      message: m,
    }),
  });
  return res.status;
}

async function receipt(chat: string, id: string, status: "delivered" | "read") {
  const res = await app.request("/api/webhooks/messaging", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.status",
      accountExternalId: "acc-1",
      provider: "linkedin",
      threadId: chat,
      externalMessageId: id,
      status,
      at: T(30),
    }),
  });
  expect(res.status).toBe(200);
}

async function channelOf(chat: string) {
  const { rows } = await q<{
    id: string;
    context_object_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `select id, context_object_id, metadata from channels where external_id = $1`,
    [chat]
  );
  return rows;
}
async function messagesIn(channelId: string) {
  const { rows } = await q<{
    id: string;
    direction: string | null;
    external_message_id: string | null;
    delivery_status: string | null;
    author_type: string;
  }>(
    `select id, direction, external_message_id, delivery_status, author_type
       from messages where channel_id = $1 order by timestamp, id`,
    [channelId]
  );
  return rows;
}
const sideEffects = (action: string) =>
  h.emitSideEffects.mock.calls
    .map((c) => c[0] as { action: string; data: Record<string, unknown> })
    .filter((p) => p.action === action);

async function seedPerson(id: string, title: string, props: object) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties)
     values ($1,$2,null,'person',$3,$4::jsonb)`,
    [id, OWNER, title, JSON.stringify(props)]
  );
  await registerIdentitySignals(
    pgDb as never,
    id,
    extractIdentitySignals(props as Record<string, unknown>),
    "test"
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) {
    // A default this harness cannot render is dropped, never the table.
    await h
      .client!.exec(ddlFor(t))
      .catch(() => h.client!.exec(ddlFor(t, false)));
  }
  for (const name of [
    "messages_hash_unique",
    "messages_channel_ext_msg_uniq",
    "channels_external_source_id_unique",
    "channels_external_pending_uniq",
    "entity_identity_signals_type_value_idx",
  ]) {
    await h.client!.exec(baselineIndex(name));
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  h.connector = fake;
});

beforeEach(async () => {
  for (const t of [
    "messages",
    "channels",
    "entities",
    "entity_identity_signals",
    "messaging_accounts",
    "proposals",
  ]) {
    await h.client!.exec(`delete from "${t}"`);
  }
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, workspace_id, metadata)
     values ($1,$2,'linkedin','acc-1','Me on LinkedIn','connected',$3,'{}'::jsonb),
            ($4,$2,'instagram','ig-1','Me on Instagram','connected',$3,'{}'::jsonb)`,
    [ACC_ROW, OWNER, WS, IG_ROW]
  );
  await seedPerson(MARIE, "Marie Curie", {
    linkedinProviderId: "ACoMarie",
    linkedinUrl: "https://www.linkedin.com/in/marie-curie",
  });
  await seedPerson(PIERRE, "Pierre Curie", {
    linkedinUrl: "https://www.linkedin.com/in/pierre-curie",
  });
  await seedPerson(LEAD, "Lea Lead", { linkedinProviderId: "ACoLead" });
  for (const k of Object.keys(profiles)) delete profiles[k];
  for (const k of Object.keys(chatMessages)) delete chatMessages[k];
  conversations.length = 0;
  h.emitSideEffects.mockClear();
  h.send.mockClear();
  fake.getProfile.mockClear();
  fake.getChat.mockClear();
});

describe("a message lands once in the person's channel", () => {
  it("the webhook and the history import of the same message are ONE row; the import fires no automation", async () => {
    // Live: Marie writes; the webhook lands it, bound to her by her id.
    expect(
      await webhook(msg("chat-marie", "m2", { from: "ACoMarie", sentAt: T(5) }))
    ).toBe(200);
    const [ch] = await channelOf("chat-marie");
    expect(ch?.context_object_id).toBe(MARIE);

    // The import later reads the same chat: m2 again (same provider id, the
    // provider's own time format) and an older outbound m1.
    conversations.push({
      externalThreadId: "chat-marie",
      provider: "linkedin",
      participantName: "Marie Curie",
      participantExternalId: "ACoMarie",
      lastMessageAt: T(5),
      lastMessagePreview: "",
      unread: false,
    });
    chatMessages["chat-marie"] = [
      msg("chat-marie", "m2", {
        from: "ACoMarie",
        sentAt: "2026-11-01T10:05:00Z",
      }),
      msg("chat-marie", "m1", { direction: "outbound", sentAt: T(1) }),
    ];
    h.emitSideEffects.mockClear();
    const result = await runMessagingHistoryImport(
      { accountExternalId: "acc-1", userId: OWNER },
      { connector: fake as never, sleep: async () => {} }
    );
    expect(result).toMatchObject({
      status: "done",
      chatsImported: 1,
      messagesRecorded: 1,
    });

    const rows = await messagesIn(ch!.id);
    expect(rows.map((r) => [r.external_message_id, r.direction])).toEqual([
      ["m1", "outbound"],
      ["m2", "inbound"],
    ]);
    expect(rows[0]!.delivery_status).toBe("sent");
    // The channel still shows its NEWEST message, not the oldest imported.
    const [after] = await channelOf("chat-marie");
    expect(Date.parse(after!.metadata.lastMessageAt as string)).toBe(
      Date.parse(T(5))
    );
    // History is not news: no automation event, no webhook fan-out.
    expect(h.emitSideEffects).not.toHaveBeenCalled();
    // Progress is kept on the account.
    const { rows: acc } = await q<{ metadata: Record<string, unknown> }>(
      `select metadata from messaging_accounts where id = $1`,
      [ACC_ROW]
    );
    expect(acc[0]!.metadata.historyImport).toMatchObject({ status: "done" });
  });

  it("the import skips a chat with someone not in the pod", async () => {
    conversations.push({
      externalThreadId: "chat-stranger",
      provider: "linkedin",
      participantName: "Stranger",
      participantExternalId: "ACoStranger",
    });
    chatMessages["chat-stranger"] = [msg("chat-stranger", "s1")];
    const result = await runMessagingHistoryImport(
      { accountExternalId: "acc-1", userId: OWNER },
      { connector: fake as never, sleep: async () => {} }
    );
    expect(result).toMatchObject({ chatsSeen: 1, chatsImported: 0 });
    expect(await channelOf("chat-stranger")).toEqual([]);
    expect(fake.getMessagesPage).not.toHaveBeenCalledWith(
      "acc-1",
      "chat-stranger",
      undefined
    );
  });

  it("the provider's echo of a message the pod sent is no new row and no received event", async () => {
    // The send executor already recorded the message it sent (its own hash).
    const { rows } = await q<{ id: string }>(
      `insert into channels (user_id, workspace_id, channel_type, scope, title, context_object_type, context_object_id,
                             external_source, external_id, external_channel_id, status, metadata)
       values ($1,$2,'external','workspace','Marie Curie','entity',$3,'linkedin','chat-sent','chat-sent','active','{}'::jsonb)
       returning id`,
      [OWNER, WS, MARIE]
    );
    const channelId = rows[0]!.id;
    await q(
      `insert into messages (channel_id, user_id, role, author_type, content, hash, timestamp,
                             direction, delivery_status, external_message_id, external_source)
       values ($1,$2,'assistant','human','Hello Marie','tamper-hash-of-the-send',$3,
               'outbound','sent','sent-1','linkedin')`,
      [channelId, OWNER, T(10)]
    );

    // Unipile's message.new for that same message (is_sender).
    expect(
      await webhook(
        msg("chat-sent", "sent-1", {
          direction: "outbound",
          body: "Hello Marie",
          sentAt: T(10),
          senderName: "Me",
          senderProviderId: "ACoMe",
        })
      )
    ).toBe(200);

    expect(await messagesIn(channelId)).toHaveLength(1);
    expect(sideEffects("received")).toEqual([]);
    expect(sideEffects("sent")).toEqual([]);
  });

  it("a message the owner sent from their phone is outbound, fires `sent` (source provider), and the reply after it is a reply", async () => {
    // Sent from the LinkedIn app, in a chat the pod has never seen: the
    // person is the chat's counterpart, never the sender (the owner).
    await webhook(
      msg("chat-new", "o1", {
        direction: "outbound",
        sentAt: T(1),
        senderName: "Me",
        senderProviderId: "ACoMe",
      })
    );
    const [ch] = await channelOf("chat-new");
    expect(ch?.context_object_id).toBe(MARIE);
    expect(fake.getChat).toHaveBeenCalledTimes(1);
    const sent = sideEffects("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({
      source: "provider",
      first: true,
      entityId: MARIE,
      messageId: "o1",
    });
    expect(sideEffects("received")).toEqual([]);

    await webhook(msg("chat-new", "i1", { from: "ACoMarie", sentAt: T(2) }));
    const rows = await messagesIn(ch!.id);
    const received = sideEffects("received");
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toMatchObject({
      isReply: true,
      repliesToMessageId: rows.find((r) => r.external_message_id === "o1")!.id,
      lastOutboundAt: T(1),
      entityId: MARIE,
    });
  });

  it("an inbound message with no outbound before it is not a reply", async () => {
    await webhook(msg("chat-cold", "c1", { from: "ACoMarie", sentAt: T(1) }));
    const [received] = sideEffects("received");
    expect(received!.data.isReply).toBeUndefined();
  });
});

describe("the person is found, once, and only the right one", () => {
  it("a second message from an unknown sender does not repeat the lookup", async () => {
    profiles.ACoStranger = {
      providerId: "ACoStranger",
      publicIdentifier: "some-stranger",
      name: "Stranger",
      networkDistance: "SECOND_DEGREE",
    };
    await webhook(msg("chat-s", "s1", { from: "ACoStranger", sentAt: T(1) }));
    await webhook(msg("chat-s", "s2", { from: "ACoStranger", sentAt: T(2) }));

    expect(fake.getProfile).toHaveBeenCalledTimes(1);
    const [ch] = await channelOf("chat-s");
    expect(ch?.context_object_id).toBeNull();
    expect(ch?.metadata.participantLookup).toMatchObject({
      result: "no-match",
    });
    const { rows } = await q<{ metadata: Record<string, unknown> }>(
      `select metadata from messaging_accounts where id = $1`,
      [ACC_ROW]
    );
    expect(rows[0]!.metadata.profileLookups).toMatchObject({ count: 1 });
  });

  it("a lookup that finds the person by their LinkedIn URL binds the chat and stores their id", async () => {
    profiles.ACoPierre = {
      providerId: "ACoPierre",
      publicIdentifier: "pierre-curie",
      name: "Pierre Curie",
      networkDistance: "FIRST_DEGREE",
    };
    await webhook(msg("chat-p", "p1", { from: "ACoPierre" }));
    const [ch] = await channelOf("chat-p");
    expect(ch?.context_object_id).toBe(PIERRE);
    // Her id is learned as an identity signal; her properties are untouched
    // (they are written only through the entity doors).
    const { rows } = await q<{ properties: Record<string, unknown> }>(
      `select properties from entities where id = $1`,
      [PIERRE]
    );
    expect(rows[0]!.properties.linkedinProviderId).toBeUndefined();
    const { rows: sig } = await q<{ entity_id: string }>(
      `select entity_id from entity_identity_signals where signal_type = 'external_id' and signal_value = 'linkedin:ACoPierre'`
    );
    expect(sig).toEqual([{ entity_id: PIERRE }]);

    // Next chat with Pierre: bound by the stored id, no lookup.
    await webhook(msg("chat-p2", "p2", { from: "ACoPierre" }));
    expect((await channelOf("chat-p2"))[0]?.context_object_id).toBe(PIERRE);
    expect(fake.getProfile).toHaveBeenCalledTimes(1);

    // A history import for Pierre alone finds her chat by the learned id,
    // with no second lookup.
    conversations.push({
      externalThreadId: "chat-p3",
      provider: "linkedin",
      participantName: "Pierre Curie",
      participantExternalId: "ACoPierre",
    });
    chatMessages["chat-p3"] = [msg("chat-p3", "p3", { from: "ACoPierre" })];
    const result = await runMessagingHistoryImport(
      { accountExternalId: "acc-1", userId: OWNER, entityId: PIERRE },
      { connector: fake as never, sleep: async () => {} }
    );
    expect(result).toMatchObject({ chatsImported: 1, messagesRecorded: 1 });
    expect(fake.getProfile).toHaveBeenCalledTimes(1);
    expect((await channelOf("chat-p3"))[0]?.context_object_id).toBe(PIERRE);
  });

  it("an unrelated provider id never binds to a person", async () => {
    // Another LinkedIn id with no profile match, and Marie's own id on
    // another provider: neither is Marie.
    await webhook(msg("chat-x", "x1", { from: "ACoMarieX" }));
    await webhook(msg("chat-ig", "g1", { from: "ACoMarie" }), {
      id: "ig-1",
      provider: "instagram",
    });
    expect((await channelOf("chat-x"))[0]?.context_object_id).toBeNull();
    expect((await channelOf("chat-ig"))[0]?.context_object_id).toBeNull();
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from entity_identity_signals where entity_id = $1`,
      [MARIE]
    );
    // Only Marie's own two signals (her id, her URL): nothing learned.
    expect(rows[0]!.n).toBe(2);
  });

  it("no lookup budget left → no lookup, and the chat is tried again later", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await q(
      `update messaging_accounts set metadata = $2::jsonb where id = $1`,
      [
        ACC_ROW,
        JSON.stringify({
          profileLookups: { day, count: PROFILE_LOOKUP_DAILY_CAP },
        }),
      ]
    );
    await webhook(msg("chat-b", "b1", { from: "ACoBudget" }));
    expect(fake.getProfile).not.toHaveBeenCalled();
    const [ch] = await channelOf("chat-b");
    expect(ch?.metadata.participantLookup).toMatchObject({
      result: "no-budget",
    });
    await q(
      `update messaging_accounts set metadata = '{}'::jsonb where id = $1`,
      [ACC_ROW]
    );
    await webhook(msg("chat-b", "b2", { from: "ACoBudget" }));
    expect(fake.getProfile).toHaveBeenCalledTimes(1);
  });
});

describe("a person's channel before the first message", () => {
  it("openPersonChannel makes ONE pending channel, and the first message gives it its chat id", async () => {
    const a = await openPersonChannel({
      userId: OWNER,
      entityId: LEAD,
      provider: "linkedin",
      accountId: "acc-1",
    });
    const b = await openPersonChannel({
      userId: OWNER,
      entityId: LEAD,
      provider: "linkedin",
      accountId: "acc-1",
    });
    expect(a).toMatchObject({ externalId: null, created: true });
    expect(b).toEqual({ ...a, created: false });
    // Opening it asked for the person's history, once.
    expect(
      h.send.mock.calls.filter((c) => c[0] === "messaging-history-import")
    ).toEqual([
      [
        "messaging-history-import",
        { accountExternalId: "acc-1", userId: OWNER, entityId: LEAD },
      ],
    ]);

    await webhook(msg("chat-lead", "l1", { from: "ACoLead" }));
    const { rows } = await q<{ id: string; external_id: string | null }>(
      `select id, external_id from channels where context_object_id = $1`,
      [LEAD]
    );
    expect(rows).toEqual([{ id: a.channelId, external_id: "chat-lead" }]);
    expect(await messagesIn(a.channelId)).toHaveLength(1);
  });
});

describe("review fixes (#698)", () => {
  async function seedChannel(chat: string, entityId: string | null) {
    const { rows } = await q<{ id: string }>(
      `insert into channels (user_id, workspace_id, channel_type, scope, title, context_object_type, context_object_id,
                             external_source, external_id, external_channel_id, status, metadata)
       values ($1,$2,'external','workspace','Chat',$3,$4,'linkedin',$5,$5,'active','{"accountId":"acc-1"}'::jsonb)
       returning id`,
      [OWNER, WS, entityId ? "entity" : null, entityId, chat]
    );
    return rows[0]!.id;
  }

  it("a message the retired backfill stored (no provider id) is stamped, not imported twice", async () => {
    const channelId = await seedChannel("chat-legacy", MARIE);
    // The old webhook / backfill: seed thread:sentAt:body, no message id.
    const oldHash = (sentAt: string, body: string) =>
      createHash("sha256")
        .update(`linkedin:chat-legacy:${sentAt}:${body}`)
        .digest("hex");
    for (const [sentAt, body] of [
      [T(3), "hello from before"],
      [T(4), "the provider wrote this time differently"],
    ] as const) {
      await q(
        `insert into messages (channel_id, user_id, role, author_type, content, hash, timestamp, direction, external_source)
         values ($1,$2,'user','external',$3,$4,$5,'inbound','linkedin')`,
        [channelId, OWNER, body, oldHash(sentAt, body), sentAt]
      );
    }
    conversations.push({
      externalThreadId: "chat-legacy",
      provider: "linkedin",
      participantName: "Marie Curie",
      participantExternalId: "ACoMarie",
    });
    chatMessages["chat-legacy"] = [
      // Same time string: the legacy hash matches.
      msg("chat-legacy", "L1", { body: "hello from before", sentAt: T(3) }),
      // Another format of the same instant: matched by time + text. It was the
      // owner's own message the backfill stored as inbound.
      msg("chat-legacy", "L2", {
        body: "the provider wrote this time differently",
        sentAt: "2026-11-01T10:04:00Z",
        direction: "outbound",
      }),
    ];
    const result = await runMessagingHistoryImport(
      { accountExternalId: "acc-1", userId: OWNER },
      { connector: fake as never, sleep: async () => {} }
    );
    expect(result).toMatchObject({ chatsImported: 1, messagesRecorded: 0 });
    const rows = await messagesIn(channelId);
    expect(rows.map((r) => [r.external_message_id, r.direction])).toEqual([
      ["L1", "inbound"],
      ["L2", "outbound"],
    ]);
  });

  it("openPersonChannel binds the chat the person already wrote in, never a pending twin", async () => {
    const ADA = randomUUID();
    // Ada writes while the pod does not know her: the chat stays unbound.
    await webhook(msg("chat-ada", "a1", { from: "ACoAda" }));
    const [chat] = await channelOf("chat-ada");
    expect(chat?.context_object_id).toBeNull();
    // She becomes a lead, her LinkedIn id known; the first draft opens her
    // channel.
    await seedPerson(ADA, "Ada Lovelace", { linkedinProviderId: "ACoAda" });
    const opened = await openPersonChannel({
      userId: OWNER,
      entityId: ADA,
      provider: "linkedin",
      accountId: "acc-1",
    });
    expect(opened).toEqual({
      channelId: chat!.id,
      externalId: "chat-ada",
      created: false,
    });
    const { rows } = await q<{ id: string }>(
      `select id from channels where context_object_id = $1 and status = 'active'`,
      [ADA]
    );
    expect(rows).toEqual([{ id: chat!.id }]);
  });

  it("binding a chat folds the person's pending channel into it, drafts included", async () => {
    const BEA = randomUUID();
    await webhook(msg("chat-bea", "b1", { from: "ACoBea" }));
    await seedPerson(BEA, "Bea Lead", {});
    // A draft before the pod knows her LinkedIn id: a pending channel.
    const pending = await openPersonChannel({
      userId: OWNER,
      entityId: BEA,
      provider: "linkedin",
      accountId: "acc-1",
    });
    expect(pending.created).toBe(true);
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, created_by, workspace_id, target_type, target_id, proposal_type, data, status)
       values ($1,$2,$3,'messaging',$4,'messaging.external.send',$5::jsonb,'pending')`,
      [
        proposalId,
        OWNER,
        WS,
        pending.channelId,
        JSON.stringify({ channelId: pending.channelId, text: "Hi Bea" }),
      ]
    );
    // Her id becomes known, then she writes again: the chat binds to her.
    await registerIdentitySignals(
      pgDb as never,
      BEA,
      [{ type: "external_id", value: "linkedin:ACoBea" }],
      "test"
    );
    await webhook(msg("chat-bea", "b2", { from: "ACoBea", sentAt: T(1) }));
    const [chat] = await channelOf("chat-bea");
    expect(chat?.context_object_id).toBe(BEA);
    const { rows } = await q<{ id: string; status: string }>(
      `select id, status from channels where context_object_id = $1 order by status`,
      [BEA]
    );
    expect(rows).toEqual([
      { id: chat!.id, status: "active" },
      { id: pending.channelId, status: "archived" },
    ]);
    const { rows: prop } = await q<{ target_id: string; channel: string }>(
      `select target_id, data->>'channelId' as channel from proposals where id = $1`,
      [proposalId]
    );
    expect(prop).toEqual([{ target_id: chat!.id, channel: chat!.id }]);
  });

  it("a channel opened from a draft is pinned to the account's workspace, never pod-wide", async () => {
    const opened = await openPersonChannel({
      userId: OWNER,
      entityId: LEAD,
      provider: "linkedin",
      accountId: "acc-1",
    });
    const { rows } = await q<{ workspace_id: string | null; scope: string }>(
      `select workspace_id, scope from channels where id = $1`,
      [opened.channelId]
    );
    expect(rows).toEqual([{ workspace_id: WS, scope: "workspace" }]);
  });

  it("a lookup that found nobody is tried again after 30 days", async () => {
    await webhook(msg("chat-old", "o1", { from: "ACoNobody" }));
    expect(fake.getProfile).toHaveBeenCalledTimes(1);
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await q(
      `update channels set metadata = jsonb_set(metadata, '{participantLookup,at}', to_jsonb($2::text)) where external_id = $1`,
      ["chat-old", old]
    );
    await webhook(msg("chat-old", "o2", { from: "ACoNobody", sentAt: T(1) }));
    expect(fake.getProfile).toHaveBeenCalledTimes(2);
  });

  it("a group chat is never bound to one sender", async () => {
    await webhook(msg("group-1", "g1", { from: "ACoMarie" }));
    await webhook(msg("group-1", "g2", { from: "ACoMarie", sentAt: T(1) }));
    const [ch] = await channelOf("group-1");
    expect(ch?.context_object_id).toBeNull();
    expect(ch?.metadata.groupChat).toBe(true);
  });

  it("a second whole-account import while one runs does nothing", async () => {
    await q(
      `update messaging_accounts set metadata = $2::jsonb where id = $1`,
      [
        ACC_ROW,
        JSON.stringify({
          historyImportLease: {
            runId: "another-run",
            until: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      ]
    );
    fake.getConversations.mockClear();
    const result = await runMessagingHistoryImport(
      { accountExternalId: "acc-1", userId: OWNER },
      { connector: fake as never, sleep: async () => {} }
    );
    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_running",
    });
    expect(fake.getConversations).not.toHaveBeenCalled();
  });

  it("a deleted outbound message does not make the next inbound a reply", async () => {
    await webhook(
      msg("chat-del", "d1", {
        direction: "outbound",
        senderName: "Me",
        senderProviderId: "ACoMe",
        sentAt: T(1),
      })
    );
    await q(
      `update messages set deleted_at = now() where external_message_id = 'd1'`
    );
    h.emitSideEffects.mockClear();
    await webhook(msg("chat-del", "d2", { from: "ACoMarie", sentAt: T(2) }));
    const [received] = sideEffects("received");
    expect(received!.data.isReply).toBeUndefined();
  });
});

describe("delivery status moves forward only", () => {
  it("delivered then read → read; a late delivered never moves it back", async () => {
    await webhook(
      msg("chat-r", "r1", {
        direction: "outbound",
        senderName: "Me",
        senderProviderId: "ACoMe",
      })
    );
    const [ch] = await channelOf("chat-r");
    await receipt("chat-r", "r1", "delivered");
    expect((await messagesIn(ch!.id))[0]!.delivery_status).toBe("delivered");
    await receipt("chat-r", "r1", "read");
    await receipt("chat-r", "r1", "delivered");
    expect((await messagesIn(ch!.id))[0]!.delivery_status).toBe("read");
  });

  it("a receipt never moves an inbound message", async () => {
    await webhook(msg("chat-in", "n1", { from: "ACoMarie" }));
    await receipt("chat-in", "n1", "read");
    const [ch] = await channelOf("chat-in");
    expect((await messagesIn(ch!.id))[0]!.delivery_status).toBeNull();
  });
});
