/**
 * Founder decision 7 — per connection, the person PINS it and chooses what
 * they HEAR about it (`everything | problems | nothing`, default `problems`).
 * Driven through the real store (`connection-prefs.ts`, the pod-wide
 * `notification_preferences.connection_prefs`) and the real
 * `NotificationService.create`, read back out of PGlite.
 *
 * 1. Writes MERGE one key, one field at a time: a pin then a level on the same
 *    connection keep both; another connection's write keeps the first.
 * 2. The notify level is REAL: a connection notice is written or not by the
 *    level of the connection it names — and only that connection's.
 *
 * Stubbed: socket, Expo, side-effect emitters, the event log.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

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
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 0, revoked: 0, failed: 0 }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  notifications,
  notificationPreferences,
  users,
} from "@synap/database";
import { NotificationService } from "../NotificationService.js";
import {
  connectionPrefPatchSchema,
  readConnectionPrefs,
  writeConnectionPref,
  normalizeConnectionPrefs,
} from "../connection-prefs.js";
import { getNotificationDef } from "../registry.js";

const USER = "11111111-1111-4111-8111-111111111111";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const GOOGLE = { kind: "account", id: "google" } as const;

/** One connection notice about `account:google`, through the real door. */
const notice = (type: string, connection: typeof GOOGLE | null = GOOGLE) =>
  NotificationService.create({
    type,
    sourceType: "connector",
    userId: USER,
    workspaceId: null,
    connection: connection ?? undefined,
    data: { connectorName: "Google", itemCount: 3, errorMessage: "boom" },
  });

describe("connection prefs — pin + notify level (decision 7)", () => {
  beforeAll(async () => {
    for (const t of [notifications, notificationPreferences, users]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `alter table notifications alter column status set default 'unread'`
    );
    await h.client!.exec(
      `alter table notification_preferences alter column enabled set default true`
    );
    // 0290 — the conflict target of the pod-wide upsert.
    await h.client!.exec(
      `create unique index notif_prefs_user_pod_unique on notification_preferences (user_id) where workspace_id is null`
    );
    await q(
      `insert into users (id, email, name, timezone) values ($1, 'a@example.test', 'Antoine', 'UTC')`,
      [USER]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  it("merges one key and one field at a time — nothing is replaced", async () => {
    await writeConnectionPref(USER, { kind: "app", id: "a1", pinned: true });
    const second = await writeConnectionPref(USER, {
      kind: "app",
      id: "a1",
      notify: "nothing",
    });
    expect(second).toEqual({
      key: "app:a1",
      pref: { pinned: true, notify: "nothing" },
    });
    await writeConnectionPref(USER, { ...GOOGLE, notify: "everything" });

    expect(await readConnectionPrefs(USER)).toEqual({
      "app:a1": { pinned: true, notify: "nothing" },
      "account:google": { pinned: false, notify: "everything" },
    });
    // Still ONE pod-wide row.
    const rows = await q<{ n: number }>(
      `select count(*)::int as n from notification_preferences where user_id = $1 and workspace_id is null`,
      [USER]
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("merges into a pod-wide row that already holds other settings", async () => {
    await q(
      `insert into notification_preferences (user_id, workspace_id, enabled, routing_rules) values ($1, null, true, '{"ai":"mute"}'::jsonb)`,
      [USER]
    );
    await writeConnectionPref(USER, { kind: "model", id: "openai", pinned: true });
    const row = await q<{ routing_rules: unknown; connection_prefs: unknown }>(
      `select routing_rules, connection_prefs from notification_preferences where user_id = $1`,
      [USER]
    );
    expect(row.rows[0]!.routing_rules).toEqual({ ai: "mute" });
    expect(row.rows[0]!.connection_prefs).toEqual({
      "model:openai": { pinned: true },
    });
  });

  it("refuses an empty patch and an unknown kind", () => {
    expect(
      connectionPrefPatchSchema.safeParse({ kind: "app", id: "a1" }).success
    ).toBe(false);
    expect(
      connectionPrefPatchSchema.safeParse({
        kind: "printer",
        id: "x",
        pinned: true,
      }).success
    ).toBe(false);
  });

  it("drops stored keys and values it cannot read", () => {
    expect(
      normalizeConnectionPrefs({
        "app:a1": { notify: "loud" },
        "printer:x": { pinned: true },
        "agent:": { pinned: true },
        "agent:z": { notify: "nothing" },
      })
    ).toEqual({ "agent:z": { pinned: false, notify: "nothing" } });
  });

  it("the three connector types are classified on the registry", () => {
    expect(getNotificationDef("connector.auth.expired")?.connectionNotice).toBe(
      "problem"
    );
    expect(getNotificationDef("connector.sync.failed")?.connectionNotice).toBe(
      "problem"
    );
    expect(
      getNotificationDef("connector.sync.complete")?.connectionNotice
    ).toBe("info");
  });

  it("default (problems): a problem lands, news that it worked does not", async () => {
    expect(await notice("connector.auth.expired")).toBeTruthy();
    expect(await notice("connector.sync.complete")).toBeUndefined();
  });

  it("nothing: no notice about that connection is written", async () => {
    await writeConnectionPref(USER, { ...GOOGLE, notify: "nothing" });
    expect(await notice("connector.auth.expired")).toBeUndefined();
    expect(await notice("connector.sync.failed")).toBeUndefined();
    const rows = await q(`select id from notifications`);
    expect(rows.rows).toHaveLength(0);
  });

  it("everything: news that it worked lands too", async () => {
    await writeConnectionPref(USER, { ...GOOGLE, notify: "everything" });
    expect(await notice("connector.sync.complete")).toBeTruthy();
    expect(await notice("connector.auth.expired")).toBeTruthy();
  });

  it("only the NAMED connection's level applies", async () => {
    await writeConnectionPref(USER, { kind: "account", id: "slack", notify: "nothing" });
    expect(await notice("connector.auth.expired")).toBeTruthy();
    // A notice that names no connection is never gated.
    await writeConnectionPref(USER, { ...GOOGLE, notify: "nothing" });
    expect(await notice("connector.auth.expired", null)).toBeTruthy();
  });
});
