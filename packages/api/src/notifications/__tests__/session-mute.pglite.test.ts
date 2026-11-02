/**
 * THE PER-SESSION MUTE and THE DELIVERED DIGEST'S place in the budget (plan
 * d679e92c C9, wave 065982de W3-notify), through the real door,
 * `NotificationService.create`, on PGlite:
 *
 *   - a muted session's pushes are held back whatever reaches it: a status
 *     signal about it (`sourceType: "session"`), an @mention in its room
 *     (`data.channelId`), a proposal filed in it (`proposals.session_id`);
 *   - held back, never hidden: each row still lands, unread (bell +
 *     needs-you), and a muted push is not counted in the daily cap;
 *   - another session still pushes; unmuting restores the push;
 *   - the mute write (`writeSessionMute`) is idempotent, keeps the person's
 *     push categories, and a category write keeps the mutes;
 *   - the delivered digest pushes past the daily cap and is never counted.
 *
 * Real: `NotificationService.create`, `push-decision.ts`, `push-prefs.ts`, the
 * tables. Stubbed: Expo + socket (captured), the side-effect emitters.
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
  pushes: [] as Array<Record<string, unknown>>,
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
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  notificationPreferences,
  proposals,
  users,
} from "@synap/database";
import {
  PUSH_DAILY_CAP,
  PUSH_MUTED_SESSIONS_MAX,
} from "@synap-core/types/push";
import { NotificationService } from "../NotificationService.js";
import {
  readPushPrefs,
  writePushPrefs,
  writeSessionMute,
} from "../push-prefs.js";

const USER = "11111111-1111-4111-8111-111111111111";
const MUTED = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MUTED_ROOM = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
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

/** A status signal about a session: `late-or-stuck`, inside the cap. */
const sessionSignal = (sessionId: string, n = 1) =>
  NotificationService.create({
    type: "session.signal",
    userId: USER,
    workspaceId: null,
    sourceType: "session",
    sourceId: sessionId,
    groupKey: `status-signal:stuck:${sessionId}:${n}`,
    data: { headline: `Stuck ${n}`, detail: "Its step took too long." },
  });

const pushedRows = async () =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from notifications where pushed_at is not null`
    )
  ).rows[0]!.n;

describe("the per-session mute", () => {
  beforeAll(async () => {
    for (const t of [
      notifications,
      notificationPreferences,
      users,
      focusSessions,
      proposals,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `alter table notifications alter column status set default 'unread'`
    );
    // The pod-wide row's conflict target (0290's partial unique index).
    await h.client!.exec(
      `create unique index np_pod_wide on notification_preferences (user_id) where workspace_id is null`
    );
    await q(
      `insert into users (id, email, name, timezone) values ($1, 'a@example.test', 'Antoine', 'UTC')`,
      [USER]
    );
    await q(
      `insert into focus_sessions (id, user_id, goal, status, channel_id) values ($1, $2, 'Muted work', 'active', $3), ($4, $2, 'Other work', 'active', null)`,
      [MUTED, USER, MUTED_ROOM, OTHER]
    );
    await q(
      `insert into proposals (id, session_id, status) values ($1, $2, 'pending')`,
      [PROPOSAL, MUTED]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.pushes.length = 0;
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  it("the write is idempotent, keeps the categories, and a category write keeps the mutes", async () => {
    await writePushPrefs(USER, { categories: { mention: false } });
    expect(await writeSessionMute(USER, MUTED, true)).toBe(true);
    expect(await writeSessionMute(USER, MUTED.toUpperCase(), true)).toBe(true);
    expect(await readPushPrefs(USER)).toEqual({
      categories: { mention: false },
      mutedSessions: [MUTED],
    });
    await writePushPrefs(USER, { categories: { "late-or-stuck": true } });
    expect((await readPushPrefs(USER)).mutedSessions).toEqual([MUTED]);
    expect(await writeSessionMute(USER, MUTED, false)).toBe(false);
    expect(await readPushPrefs(USER)).toEqual({
      categories: { mention: false, "late-or-stuck": true },
    });
  });

  it("the stored list is trimmed to its max in the same write, the oldest mute first", async () => {
    const full = Array.from({ length: PUSH_MUTED_SESSIONS_MAX }, () =>
      randomUUID()
    );
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, push_prefs) values ($1, $2, null, $3::jsonb)`,
      [randomUUID(), USER, JSON.stringify({ mutedSessions: full })]
    );
    expect(await writeSessionMute(USER, MUTED, true)).toBe(true);
    expect(await writeSessionMute(USER, OTHER, true)).toBe(true);
    const stored = async () =>
      (
        await q<{ muted: string[] }>(
          `select push_prefs->'mutedSessions' as muted from notification_preferences where user_id = $1`,
          [USER]
        )
      ).rows[0]!.muted;
    // The column itself, not the read's cap: what is stored is what is read.
    expect(await stored()).toEqual([...full.slice(2), MUTED, OTHER]);
    // An unmute does not bring the oldest mute back inside the window.
    expect(await writeSessionMute(USER, OTHER, false)).toBe(false);
    expect(await stored()).toEqual([...full.slice(2), MUTED]);
    expect((await readPushPrefs(USER)).mutedSessions).not.toContain(full[0]);
  });

  it("a muted session's push is held back; its row lands unread; another session still pushes", async () => {
    await writeSessionMute(USER, MUTED, true);
    await sessionSignal(MUTED);
    expect(h.pushes).toHaveLength(0);
    const rows = await q<{ status: string; pushed: boolean }>(
      `select status, pushed_at is not null as pushed from notifications`
    );
    expect(rows.rows).toEqual([{ status: "unread", pushed: false }]);

    await sessionSignal(OTHER);
    expect(h.pushes).toHaveLength(1);

    // Unmuted, it pushes again.
    await writeSessionMute(USER, MUTED, false);
    await sessionSignal(MUTED, 2);
    expect(h.pushes).toHaveLength(2);
  });

  it("an @mention in the muted session's room and a proposal filed in it are held back too", async () => {
    await writeSessionMute(USER, MUTED, true);
    await NotificationService.create({
      type: "chat.mention",
      userId: USER,
      workspaceId: null,
      sourceType: "system",
      sourceId: MUTED_ROOM,
      data: {
        sender: "An agent",
        preview: "@Antoine look",
        channelId: MUTED_ROOM,
        messageId: randomUUID(),
      },
    });
    await NotificationService.create({
      type: "proposal.created",
      userId: USER,
      workspaceId: null,
      sourceType: "proposal",
      sourceId: PROPOSAL,
      data: { proposalType: "update_entity", description: "A change" },
      push: { facts: { proposalBlocksOpenSession: true } },
    });
    expect(h.pushes).toHaveLength(0);
    expect(
      (await q<{ n: number }>(`select count(*)::int as n from notifications`))
        .rows[0]!.n
    ).toBe(2);
  });

  it("a muted push is not counted: the cap's pushes are still all there for other work", async () => {
    await writeSessionMute(USER, MUTED, true);
    for (let n = 1; n <= PUSH_DAILY_CAP; n++) await sessionSignal(MUTED, n);
    for (let n = 1; n <= PUSH_DAILY_CAP; n++) await sessionSignal(OTHER, n);
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP);
    expect(await pushedRows()).toBe(PUSH_DAILY_CAP);
  });

  it("the delivered digest pushes past the daily cap and is never counted", async () => {
    for (let n = 1; n <= PUSH_DAILY_CAP; n++) await sessionSignal(OTHER, n);
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP);
    await NotificationService.create({
      type: "ai.proactive.delivered_digest",
      userId: USER,
      workspaceId: null,
      sourceType: "proactive_message",
      groupKey: "delivered-digest:2026-11-01",
      data: {
        title: "Delivered since your last digest",
        body: "2 pull requests merged.",
      },
    });
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP + 1);
    expect(h.pushes.at(-1)).toMatchObject({
      data: {
        type: "ai.proactive.delivered_digest",
        pushCategory: "delivered-digest",
      },
      interruptionLevel: "passive",
    });
  });
});
