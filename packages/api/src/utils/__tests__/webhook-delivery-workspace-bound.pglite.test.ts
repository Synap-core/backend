/**
 * Producer 2 (`deliverWebhooksForEvent`: chat events, entity property updates)
 * honours a subscription's WORKSPACE binding (O4) — the same rule producer 1
 * applies (`subscriptionCoversWorkspace`, jobs webhook-worker).
 *
 * Real on PGlite: the subscription read, the entity read floor
 * (`scopedDb(AccessContext.operator)` over `entities`), and the subject's own
 * workspace (the entity's / channel's `workspace_id` row). Mocked: pg-boss
 * (`getBoss` — a recorder: what is enqueued IS the audience) and the channel
 * reader set (pinned by `chat-realtime-audience.pglite.test.ts`).
 *
 * The defect: a subscription bound to workspace W received every event its
 * owner could read, in every space.
 *
 * Rows rule out: no workspace filter (the WS2 rows), dropping unbound
 * subscriptions, a pod-wide subject or a subject-less `user` event reaching a
 * bound subscription, and trusting a payload's `workspaceId` over the row.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sent: [] as Array<{ subscriptionId?: string }>,
  channelReaders: [] as string[],
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
  getBoss: () => ({
    send: async (_q: string, data: { subscriptionId?: string }) => {
      h.sent.push(data);
      return "job";
    },
  }),
}));
vi.mock("../channel-visibility.js", () => ({
  listChannelAudienceUserIds: async () => h.channelReaders,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { deliverWebhooksForEvent } from "../webhook-delivery.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID();
const WS1 = randomUUID();
const WS2 = randomUUID();
const E_WS1 = randomUUID();
const E_POD = randomUUID();
const CH_WS2 = randomUUID();
const SUB = { unbound: randomUUID(), ws1: randomUUID(), ws2: randomUUID() };
const EVENT = "entity.update.completed";

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1,'a@example.test')`, [A]);
  for (const ws of [WS1, WS2]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  for (const [id, ws] of [
    [E_WS1, WS1],
    [E_POD, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, properties, system_data)
       values ($1,$2,$3,'note','n','{}'::jsonb,'{}'::jsonb)`,
      [id, A, ws]
    );
  }
  await q(
    `insert into channels (id, title, user_id, workspace_id, channel_type) values ($1,'c',$2,$3,'workspace')`,
    [CH_WS2, A, WS2]
  );
  for (const [id, ws] of [
    [SUB.unbound, null],
    [SUB.ws1, WS1],
    [SUB.ws2, WS2],
  ] as const) {
    await q(
      `insert into webhook_subscriptions (id, user_id, workspace_id, name, url, event_types, secret, active, retry_config)
       values ($1,$2,$3,'s','https://hook.example/x','{${EVENT}}','sec',true,'{"maxRetries":0}'::jsonb)`,
      [id, A, ws]
    );
  }
});

beforeEach(() => {
  h.sent = [];
  h.channelReaders = [A];
});

const audience = () => h.sent.map((d) => d.subscriptionId!).sort();

describe("deliverWebhooksForEvent — workspace-bound subscriptions", () => {
  it("an entity in WS1 reaches the unbound and the WS1-bound subscription, never WS2's", async () => {
    await deliverWebhooksForEvent(
      EVENT,
      { entityId: E_WS1 },
      { kind: "entity", entityId: E_WS1 }
    );
    expect(audience()).toEqual([SUB.unbound, SUB.ws1].sort());
  });

  it("the subject's row decides, not a payload's workspaceId", async () => {
    await deliverWebhooksForEvent(
      EVENT,
      { entityId: E_WS1, workspaceId: WS2 },
      { kind: "entity", entityId: E_WS1 }
    );
    expect(audience()).toEqual([SUB.unbound, SUB.ws1].sort());
  });

  it("a pod-wide entity reaches unbound subscriptions only", async () => {
    await deliverWebhooksForEvent(
      EVENT,
      { entityId: E_POD },
      { kind: "entity", entityId: E_POD }
    );
    expect(audience()).toEqual([SUB.unbound]);
  });

  it("a channel in WS2 reaches the unbound and the WS2-bound subscription", async () => {
    await deliverWebhooksForEvent(
      EVENT,
      {},
      { kind: "channel", channelId: CH_WS2, trusted: true, actorUserId: A }
    );
    expect(audience()).toEqual([SUB.unbound, SUB.ws2].sort());
  });

  it("a subject-less user event reaches unbound subscriptions only", async () => {
    await deliverWebhooksForEvent(EVENT, {}, { kind: "user", userId: A });
    expect(audience()).toEqual([SUB.unbound]);
  });
});
