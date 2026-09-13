/**
 * `notifCenter.requestHandoff` — "Continue on desktop", driven through the REAL
 * procedure and the REAL `NotificationService.create` on PGlite.
 *
 * Real: the owner floor, the dedup read, preference routing, the registry row
 * (title template, verbatim actions, `channelCeiling`) and the persisted row.
 * Tables are generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `emitChatEvent` — the Socket.IO bridge; captured so the user-room emit is
 *    asserted, not assumed.
 *  - `sendExpoPush` — a third-party HTTP hop; captured so "never pushed back to
 *    the phone" is asserted.
 *  - `eventRepository.append` / `emitSideEffects` — fire-and-forget audit and
 *    automation fan-out on their own connections; not what this door decides.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  emits: [] as Array<{ event: string; userId?: string; data: unknown }>,
  pushes: [] as unknown[],
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
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});

vi.mock("../utils/chat-realtime-broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitChatEvent: (e: { event: string; userId?: string; data: unknown }) => {
      h.emits.push(e);
    },
  };
});

// Every tRPC mutation passes the read-only (split-brain) guard, which reads the
// sync-generation table on its own schema key — not what this door decides.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../notifications/expo-push.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendExpoPush: async (payload: unknown) => {
      h.pushes.push(payload);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  notifications,
  notificationPreferences,
} from "@synap/database";
import { notifCenterRouter } from "./notif-center.js";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id" && type === "uuid"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "status" && cfg.name === "notifications"
            ? " default 'unread'"
            : c.name === "actions"
              ? " default '[]'"
              : c.name === "enabled"
                ? " default true"
                : c.name === "priority"
                  ? " default 'normal'"
                  : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(owner: string, goal = "Capture · meeting notes") {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1, $2, $3, 'active', '{}'::jsonb, now(), now())`,
    [id, owner, goal]
  );
  return id;
}

const request = (
  userId: string,
  input: { target: { kind: string; id: string }; view: string }
) =>
  notifCenterRouter
    .createCaller({ db, authenticated: true, userId } as never)
    .requestHandoff(input as never);

const rowsFor = (sessionId: string) =>
  q<{
    id: string;
    user_id: string;
    type: string;
    title: string;
    source_type: string;
    source_id: string;
    status: string;
    actions: unknown;
  }>(`select * from notifications where source_id = $1`, [sessionId]).then(
    (r) => r.rows
  );

describe("notifCenter.requestHandoff", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, notifications, notificationPreferences]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from notifications; delete from notification_preferences;"
    );
    h.emits.length = 0;
    h.pushes.length = 0;
  });

  it("writes one handoff notification for the owner's session and emits it to the owner's room", async () => {
    const id = await session(OWNER);

    const result = await request(OWNER, {
      target: { kind: "session", id },
      view: "room",
    });

    expect(result.status).toBe("sent");
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.notificationId,
      user_id: OWNER,
      type: "handoff.continue",
      source_type: "session",
      source_id: id,
      status: "unread",
      title: "Continue on desktop: Capture · meeting notes",
    });
    // Ids only: the room is addressed by {kind, sourceId, view}, nothing else.
    expect(rows[0]!.actions).toEqual([
      {
        id: "open-room",
        label: "Open room",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session", view: "room" },
      },
    ]);

    expect(h.emits).toHaveLength(1);
    expect(h.emits[0]).toMatchObject({
      event: "notification:new",
      userId: OWNER,
    });
    const payload = (
      h.emits[0]!.data as { notification: Record<string, unknown> }
    ).notification;
    expect(payload).toMatchObject({
      type: "handoff.continue",
      sourceType: "session",
      sourceId: id,
    });
  });

  it("answers the SAME not-found for someone else's session and a missing one, and writes nothing", async () => {
    const theirs = await session(STRANGER);
    const missing = randomUUID();

    const errs = await Promise.all(
      [theirs, missing].map((id) =>
        request(OWNER, { target: { kind: "session", id }, view: "room" }).then(
          () => null,
          (e: { code?: string; message?: string }) => ({
            code: e.code,
            message: e.message,
          })
        )
      )
    );

    expect(errs[0]).toEqual({
      code: "NOT_FOUND",
      message: "Session not found",
    });
    expect(errs[1]).toEqual(errs[0]);
    expect(await rowsFor(theirs)).toHaveLength(0);
    expect(h.emits).toHaveLength(0);
  });

  it("refuses a kind or view outside the allowlist", async () => {
    const id = await session(OWNER);
    for (const input of [
      { target: { kind: "entity", id }, view: "room" },
      { target: { kind: "session", id }, view: "thread" },
    ]) {
      await expect(request(OWNER, input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it("refuses an AGENT caller — a handoff is a person's own device act — and writes nothing", async () => {
    const id = await session(OWNER);

    await expect(
      notifCenterRouter
        .createCaller({
          db,
          authenticated: true,
          userId: OWNER,
          agentUserId: "agent-1",
        } as never)
        .requestHandoff({ target: { kind: "session", id }, view: "room" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rowsFor(id)).toHaveLength(0);
    expect(h.emits).toHaveLength(0);
  });

  it("reuses the unread notification for a repeat inside the window; a read one does not block a new ask", async () => {
    const id = await session(OWNER);
    const input = { target: { kind: "session", id }, view: "room" };

    const first = await request(OWNER, input);
    const second = await request(OWNER, input);
    expect(second).toEqual({
      status: "already_sent",
      notificationId: first.notificationId,
    });
    expect(await rowsFor(id)).toHaveLength(1);
    expect(h.emits).toHaveLength(1);

    await q(`update notifications set status = 'read' where id = $1`, [
      first.notificationId,
    ]);
    const third = await request(OWNER, input);
    expect(third.status).toBe("sent");
    expect(third.notificationId).not.toBe(first.notificationId);
    expect(await rowsFor(id)).toHaveLength(2);
  });

  it("never pushes back to the phone, even when the user routes system alerts to every channel", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules)
       values (gen_random_uuid(), $1, null, true, $2::jsonb)`,
      [OWNER, JSON.stringify({ system: "all" })]
    );
    const id = await session(OWNER);

    const result = await request(OWNER, {
      target: { kind: "session", id },
      view: "room",
    });

    expect(result.status).toBe("sent");
    expect(h.emits).toHaveLength(1);
    // sendExpoPush is fired without await — give it a tick before asserting none.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.pushes).toHaveLength(0);
  });

  it("is an error, not a quiet success, when the pod did not write the notification", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules)
       values (gen_random_uuid(), $1, null, true, $2::jsonb)`,
      [OWNER, JSON.stringify({ system: "mute" })]
    );
    const id = await session(OWNER);

    await expect(
      request(OWNER, { target: { kind: "session", id }, view: "room" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await rowsFor(id)).toHaveLength(0);
  });
});
