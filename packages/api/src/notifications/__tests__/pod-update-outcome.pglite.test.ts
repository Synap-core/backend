/**
 * "Update failed" is told ONCE per update per admin — across the cleanup that
 * deletes the bell row it was told by.
 *
 * The notice expires (`expiresAfterMs`) and the daily `notification-cleanup`
 * worker DELETES expired read rows. When the row was the only "already told"
 * record, the next boot re-read the unchanged `last-update.json`, found no
 * row, and told everyone again — every week, forever. Driven here through the
 * REAL producer (default deps: the record + the rows), the REAL
 * `NotificationService.create`, and the REAL cleanup worker, on PGlite.
 *
 * NOT covered: the boot caller (`apps/api/src/index.ts`) — it only hands the
 * outcome it read to `notifyPodUpdateOutcome`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
        podSettings: actual.podSettings as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 0, revoked: 0, failed: 0 }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: async () => ["owner-1"],
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  notifications,
  notificationPreferences,
  podSettings,
  users,
} from "@synap/database";
import { notifyPodUpdateOutcome } from "../pod-update-outcome.js";
import { handleNotificationCleanup } from "../../../../jobs/src/workers/notification-cleanup.js";

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

const ROLLED_BACK = {
  updateId: "u-1",
  status: "rolled_back",
  from: "v1",
  to: "v2",
  reason: "backend migration failed",
  dbRestored: true,
};

beforeAll(async () => {
  for (const t of [notifications, notificationPreferences, users, podSettings])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.exec(
    `alter table notifications alter column status set default 'unread'`
  );
  await h.client!.exec(
    `alter table pod_settings alter column settings set default '{}'::jsonb`
  );
  await q(`insert into users (id, email, timezone) values ($1, $2, 'UTC')`, [
    "owner-1",
    "owner@example.test",
  ]);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("pod.update_failed is told once — the cleanup cannot re-arm it", () => {
  it("notify → read → cleanup past expiry → next boot notifies nobody", async () => {
    expect(await notifyPodUpdateOutcome(ROLLED_BACK)).toBe(1);
    // The admin reads it; a week passes.
    await q(
      `update notifications set status = 'read', expires_at = now() - interval '1 day'`
    );
    await handleNotificationCleanup();
    // Non-vacuity: the cleanup really deleted the row the old dedupe read.
    expect((await q(`select id from notifications`)).rows).toHaveLength(0);

    // The next boot re-reads the same outcome file.
    expect(await notifyPodUpdateOutcome(ROLLED_BACK)).toBe(0);
    expect((await q(`select id from notifications`)).rows).toHaveLength(0);
  });

  it("a NEW update id is news again (the record is per outcome)", async () => {
    expect(
      await notifyPodUpdateOutcome({ ...ROLLED_BACK, updateId: "u-2" })
    ).toBe(1);
  });
});
