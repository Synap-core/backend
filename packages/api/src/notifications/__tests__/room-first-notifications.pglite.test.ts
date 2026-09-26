/**
 * Room-first notifications (founder decision 2026-09-25), driven through the
 * REAL doors and read back out of PGlite.
 *
 * M1 — an AGENT handing the person work tells them: `blockExpectedOutput`
 *   (Hub `outputs/block`, tRPC `blockOutput`) and `updateFocusSession`
 *   `addOutput { owner: 'human' }` (MCP `update_session`) each write ONE
 *   `session.needs_you` row + push; a second hand-off in the same session
 *   inside the window writes nothing; the person's OWN block writes nothing.
 * M2 — an agent's room post reaches the person: `postChannelMessage` (MCP
 *   `post_message`) with an @mention of the operator → `chat.mention` push
 *   (an agent post is NOT a self-mention); a plain `update` → NO notification
 *   at all (founder decision F, 2026-09-25 — it lives only in the room and
 *   the session's state mark); a `question` → `session.needs_you` push.
 *
 * Real: the doors above, `notifySessionNeedsYou`, `notifyRoomPost`,
 * `NotificationService.create` (preference lookup, dedupe gate, channel
 * resolution), the tables. Stubbed, and why: Expo + the socket bridge (no
 * transport; captured so the CHANNEL decisions are asserted), the channel
 * visibility predicate (its own suite; this file pins who is TOLD, not who may
 * post), the message event append, governance (granted — an agent's slot write
 * is not what is under test), the work-guideline lookup (its own suite).
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
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
        users: actual.users as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
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
vi.mock("../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  // Partial: the object-room helpers (`isObjectRoomType`, the audience) stay
  // real — the mention door asks them whether a room is an object room.
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, channelVisibilityWhere: () => sql`true` };
});
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
vi.mock(
  "../../services/focus-sessions/block-guidelines.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, guidanceForBlockedSlots: async () => undefined };
  }
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  notificationPreferences,
  users,
  channels,
  channelMembers,
  messages,
} from "@synap/database";
import { blockExpectedOutput } from "../../services/focus-sessions/block-output.js";
import { updateFocusSession } from "../../services/focus-sessions/update-session.js";
import {
  SESSION_NEEDS_YOU_NOTIFICATION_TYPE,
  sessionNeedsYouGroupKey,
  newlyOwedSlots,
} from "../../services/focus-sessions/notify-needs-you.js";
import { postChannelMessage } from "../../services/messaging/post-message.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
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

type NotifRow = {
  type: string;
  user_id: string;
  title: string;
  body: string;
  source_id: string;
  group_key: string | null;
};
const notifs = (type?: string) =>
  q<NotifRow>(
    type
      ? `select * from notifications where type = $1 order by created_at`
      : `select * from notifications order by created_at`,
    type ? [type] : []
  ).then((r) => r.rows);

const SLOTS = [
  { kind: "document", label: "Stripe key", status: "pending" },
  { kind: "document", label: "DNS record", status: "pending" },
];

async function seedSession(
  opts: { channelId?: string; title?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship billing', $3, 'active', $4::jsonb, $5, '{}'::jsonb, '[]'::jsonb, $6, now(), now(), now())`,
    [
      id,
      USER,
      opts.title ?? "Ship billing",
      JSON.stringify(SLOTS),
      [],
      opts.channelId ?? null,
    ]
  );
  return id;
}

async function seedRoom(): Promise<string> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Ship billing', now(), now())`,
    [channelId, USER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, USER]
  );
  return channelId;
}

const block = (sessionId: string, label: string, agent: boolean) =>
  blockExpectedOutput({
    sessionId,
    userId: USER,
    expectedLabel: label,
    blockedReason: "credential",
    why: "the live account's restricted key",
    ...(agent ? { agentUserId: AGENT } : {}),
  });

const post = (
  channelId: string,
  content: string,
  extra: { kind?: "question" | "update"; agent?: boolean } = {}
) =>
  postChannelMessage({
    channelId,
    content,
    userId: USER,
    ...(extra.agent === false ? {} : { agentUserId: AGENT }),
    ...(extra.kind ? { kind: extra.kind } : {}),
  });

describe("room-first notifications", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      notifications,
      notificationPreferences,
      users,
      channels,
      channelMembers,
      messages,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone) values ($1, 'a@example.test', 'Antoine Servant', 'UTC'), ($2, 'agent@example.test', 'Claude Code', 'UTC')`,
      [USER, AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.pushes.length = 0;
    h.sockets.length = 0;
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  // ── M1 ──────────────────────────────────────────────────────────────────

  it("M1: an agent's block_output notifies the person ONCE, and pushes", async () => {
    const id = await seedSession({ title: "Ship billing" });
    const r = await block(id, "Stripe key", true);
    expect(r.status).toBe("blocked");

    const rows = await notifs(SESSION_NEEDS_YOU_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER);
    expect(rows[0]!.title).toBe("Needs you: Ship billing");
    expect(rows[0]!.body).toBe(
      "Stripe key — the live account's restricted key"
    );
    expect(rows[0]!.source_id).toBe(id);
    expect(rows[0]!.group_key).toBe(sessionNeedsYouGroupKey(id));
    expect(h.pushes).toHaveLength(1);
  });

  it("M1: a SECOND hand-off in the same session inside the window adds no row and no push", async () => {
    const id = await seedSession();
    await block(id, "Stripe key", true);
    await block(id, "DNS record", true);
    expect(await notifs(SESSION_NEEDS_YOU_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);
  });

  it("M1: the dedupe DISCRIMINATES — a different session is still told", async () => {
    const a = await seedSession({ title: "A" });
    const b = await seedSession({ title: "B" });
    await block(a, "Stripe key", true);
    await block(b, "Stripe key", true);
    expect(await notifs(SESSION_NEEDS_YOU_NOTIFICATION_TYPE)).toHaveLength(2);
    expect(h.pushes).toHaveLength(2);
  });

  it("M1: the person's OWN block notifies nobody", async () => {
    const id = await seedSession();
    const r = await block(id, "Stripe key", false);
    expect(r.status).toBe("blocked"); // the write itself happened
    expect(await notifs()).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
  });

  it("M1: an agent's update_session addOutput { owner: 'human' } notifies", async () => {
    const id = await seedSession({ title: "Ship billing" });
    const r = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      addOutput: {
        kind: "document",
        label: "Approve the price",
        owner: "human",
        blockedReason: "decision",
        why: "pick monthly or annual",
      },
    });
    expect(r.status).toBe("updated");
    const rows = await notifs(SESSION_NEEDS_YOU_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("Approve the price — pick monthly or annual");
    expect(h.pushes).toHaveLength(1);
  });

  it("M1: an agent's update that adds only an AGENT-owned slot notifies nobody", async () => {
    const id = await seedSession();
    await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      addOutput: { kind: "document", label: "Release notes" },
    });
    expect(await notifs()).toHaveLength(0);
  });

  it("newlyOwedSlots: an echoed block is not new; a re-owned slot is", () => {
    const owed = { kind: "d", label: "X", owner: "human" as const };
    expect(newlyOwedSlots([owed], [owed])).toEqual([]);
    expect(newlyOwedSlots([{ kind: "d", label: "x" }], [owed])).toEqual([owed]);
    expect(newlyOwedSlots([], [{ ...owed, status: "done" as const }])).toEqual(
      []
    );
  });

  // ── M2 ──────────────────────────────────────────────────────────────────

  it("M2: an agent @mentioning its operator notifies them (not a self-mention), and pushes", async () => {
    const room = await seedRoom();
    await seedSession({ channelId: room });
    await post(room, "@antoine can you check the pricing page?");

    const rows = await notifs("chat.mention");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER);
    expect(rows[0]!.title).toBe("Claude Code mentioned you");
    expect(h.pushes).toHaveLength(1);
    // Told ONCE about this post — no update / needs_you notification on top.
    expect(await notifs()).toHaveLength(1);
  });

  it("M2: the SAME @mention written by the person themself notifies nobody", async () => {
    const room = await seedRoom();
    await post(room, "@antoine note to self", { agent: false });
    expect(await notifs()).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
  });

  it("M2: an agent's plain update in a session room creates NO notification at all (founder decision F, 2026-09-25)", async () => {
    const room = await seedRoom();
    await seedSession({ channelId: room, title: "Ship billing" });
    await post(room, "Typecheck is green, moving to the migration.");

    expect(await notifs()).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
  });

  it("M2: an agent's question in a session room pushes the session owner", async () => {
    const room = await seedRoom();
    const sid = await seedSession({ channelId: room, title: "Ship billing" });
    await post(room, "Monthly or annual billing by default?", {
      kind: "question",
    });

    const rows = await notifs(SESSION_NEEDS_YOU_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(sid);
    expect(rows[0]!.body).toBe("Monthly or annual billing by default?");
    expect(h.pushes).toHaveLength(1);
  });

  it("M2: an agent post in a room that is NOT a session's notifies nobody without a mention", async () => {
    const room = await seedRoom();
    await post(room, "Done.", { kind: "question" });
    expect(await notifs()).toHaveLength(0);
  });
});
