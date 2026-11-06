/**
 * The reconnect notice the PERSON gets: one open bell row per account, which
 * names the account it is about.
 *
 * Driven from the producer (`notifyConnectorUnhealthy`) through the real
 * `NotificationService.create` into PGlite, so the row asserted is the row
 * the bell and the push are made from — nothing hand-built in between.
 *
 * 1. The producer nudges at most every 6 h; an account that stays signed out
 *    for a day is still ONE open row (the registry's `dedupeWindowMs` on
 *    `connector.auth.expired`), until the person reads it. The registry holds
 *    on its own: N raises through the door inside the window are one row.
 * 2. The row carries the account as its object: `sourceId` = the provider and
 *    a `navigate-object` action of kind `account`, so the button and the push
 *    tap (`pushTarget`) resolve to `{kind: "account", id: <provider>}`.
 *
 * Stubbed: socket, Expo, side-effect emitters, the event log, channel origin.
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
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
        users: actual.users as never,
        tools: actual.tools as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 0, revoked: 0, failed: 0 }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));
vi.mock("../channels/channel-origin.js", () => ({
  recordChannelOrigin: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  notifications,
  notificationPreferences,
  users,
  tools,
} from "@synap/database";
import { notifyConnectorUnhealthy } from "./notify-connector-unhealthy.js";
import {
  NotificationService,
  pushTarget,
} from "../../notifications/NotificationService.js";
import { getNotificationDef } from "../../notifications/registry.js";

const USER = "22222222-2222-4222-8222-222222222222";
const HOUR = 60 * 60 * 1000;
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "updated_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

let toolId: string;

const nudge = () =>
  notifyConnectorUnhealthy({
    connectorKey: "google",
    connectorName: "Google Workspace",
    reconnectHint: "Sign in again in the app (Settings → Connections).",
    userId: USER,
    workspaceId: null,
    watermarkToolId: toolId,
  });

/** The producer's 6 h cooldown has passed: the stored nudge is 7 h old. */
const cooldownElapsed = () =>
  q(
    `update tools set metadata = jsonb_set(metadata, '{connectionHealth,google,lastNotifiedMs}', to_jsonb($2::bigint)) where id = $1`,
    [toolId, Date.now() - 7 * HOUR]
  );

type Row = {
  id: string;
  title: string;
  body: string;
  source_id: string | null;
  actions: Array<{ label: string; handler: Record<string, unknown> }>;
};
const rows = async () =>
  (
    await q<Row>(
      `select id, title, body, source_id, actions from notifications where type = 'connector.auth.expired' order by created_at`
    )
  ).rows;

describe("connector.auth.expired — one open row that names the account", () => {
  beforeAll(async () => {
    for (const t of [notifications, notificationPreferences, users, tools]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `alter table notifications alter column status set default 'unread'`
    );
    await h.client!.exec(
      `alter table notification_preferences alter column enabled set default true`
    );
    await q(
      `insert into users (id, email, name, timezone) values ($1, 'b@example.test', 'Antoine', 'UTC')`,
      [USER]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    await q(`delete from notifications`);
    toolId = randomUUID();
    await q(
      `insert into tools (id, name, metadata) values ($1, 'google', $2)`,
      [toolId, JSON.stringify({})]
    );
  });

  it("names the account: sourceId, the action and the push tap", async () => {
    expect(await nudge()).toBe(true);
    const [row, ...more] = await rows();
    expect(more).toHaveLength(0);
    expect(row!.title).toBe("Sign in to Google Workspace again");
    expect(row!.body).toBe(
      "Google Workspace stopped syncing. Sign in again to resume."
    );
    expect(row!.source_id).toBe("google");
    expect(row!.actions[0]).toMatchObject({
      label: "Sign in again",
      handler: { type: "navigate-object", kind: "account" },
    });
    // The push tap reads the same declaration, from the row's own source.
    expect(
      pushTarget(getNotificationDef("connector.auth.expired")!, {
        sourceId: row!.source_id ?? undefined,
      })
    ).toEqual({ kind: "account", id: "google" });
  });

  it("a nudge after the 6 h cooldown, while the first is unread, writes no second row", async () => {
    expect(await nudge()).toBe(true);
    await cooldownElapsed();
    // The producer nudges again (its window reopened)…
    expect(await nudge()).toBe(true);
    // …and the bell still holds ONE open row for the account.
    expect(await rows()).toHaveLength(1);
  });

  it("N raises inside the window, by any producer, leave ONE open row (the registry, not the producer's cooldown)", async () => {
    // The producer's 6 h claim is one guard; the bell must not depend on it.
    // Every producer of this type keys the account the same way.
    const raise = () =>
      NotificationService.create({
        type: "connector.auth.expired",
        sourceType: "connector",
        sourceId: "google",
        userId: USER,
        workspaceId: null,
        groupKey: "pod:connector.auth.expired:google",
        data: { connectorName: "Google Workspace" },
      });
    const first = await raise();
    expect(first).toBeTruthy();
    for (let i = 0; i < 7; i++) expect(await raise()).toBeUndefined();
    expect(await rows()).toHaveLength(1);
  });

  it("once the person has read it, the next nudge is new news", async () => {
    expect(await nudge()).toBe(true);
    await q(`update notifications set status = 'read'`);
    await cooldownElapsed();
    expect(await nudge()).toBe(true);
    expect(await rows()).toHaveLength(2);
  });
});
