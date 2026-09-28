/**
 * W2 review — the notification dedupe on a REAL table with the REAL 0281
 * index: only an OPEN repeat is suppressed; a read row lets the next one land;
 * a refreshed snoozed row resurfaces unread; a distinct message is never
 * swallowed by another message's key.
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  emitted: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
  sockets: [] as Array<Record<string, unknown>>,
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
        sessionEvaluations: actual.sessionEvaluations as never,
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (e: Record<string, unknown>) => {
      h.emitted.push(e);
    },
  };
});

vi.mock("../expo-push.js", () => ({
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (e: Record<string, unknown>) => {
    h.sockets.push(e);
  },
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
vi.mock("../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../services/proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { notifications, notificationPreferences, users } from "@synap/database";
import { NotificationService } from "../NotificationService.js";

const USER = "user-1";
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

beforeAll(async () => {
  for (const t of [notifications, notificationPreferences, users])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  // The derived DDL carries no column defaults; the real table defaults
  // `status` to 'unread' (0000 baseline), which the dedupe reads.
  await h.client!.exec(
    `alter table notifications alter column status set default 'unread'`
  );
  await q(`insert into users (id, email, timezone) values ($1, $2, 'UTC')`, [
    USER,
    "user-1@example.test",
  ]);
  // The REAL migration: its partial unique index is the race guard under test.
  await h.client!.exec(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../database/migrations/0281_notifications_open_dedupe_key.sql"
      ),
      "utf8"
    )
  );
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  await q(`delete from notifications`);
});

const notify = (groupKey: string, title = "Digest") =>
  NotificationService.create({
    type: "automation.notification",
    userId: USER,
    workspaceId: "ws-1",
    sourceType: "automation",
    sourceId: "auto-1",
    groupKey,
    data: { title, body: "b" },
  });

const rows = () =>
  q<{ id: string; status: string; dedupe_key: string | null }>(
    `select id, status, dedupe_key from notifications order by created_at`
  ).then((r) => r.rows);

describe("automation.notification dedupe", () => {
  it("an OPEN repeat inside the window is suppressed", async () => {
    expect(await notify("k1")).toBeTruthy();
    expect(await notify("k1")).toBeUndefined();
    expect(await rows()).toHaveLength(1);
  });

  it("once READ, the next occurrence lands — seen news is not a duplicate", async () => {
    expect(await notify("k1")).toBeTruthy();
    await q(`update notifications set status = 'read'`);
    expect(await notify("k1")).toBeTruthy();
    expect((await rows()).map((r) => r.status)).toEqual(["read", "unread"]);
  });

  it("a different key (a different message) is never swallowed", async () => {
    expect(await notify("k1")).toBeTruthy();
    expect(await notify("k2", "Other")).toBeTruthy();
    expect(await rows()).toHaveLength(2);
  });

  it("a SNOOZED row past the window is refreshed back to unread — one row, not two", async () => {
    const first = await notify("k1");
    await q(
      `update notifications set status = 'snoozed', snoozed_until = now() + interval '1 day', created_at = now() - interval '2 days'`
    );
    const again = await notify("k1");
    expect(again).toBe(first);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("unread");
    const [snooze] = (
      await q<{ snoozed_until: string | null }>(
        `select snoozed_until from notifications`
      )
    ).rows;
    expect(snooze!.snoozed_until).toBeNull();
  });
});
