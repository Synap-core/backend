/**
 * THE INTERRUPTION BUDGET (plan Q4.1, status-flow W6) through the real door,
 * `NotificationService.create`, on PGlite:
 *
 *   - a person gets at most `PUSH_DAILY_CAP` (3) pushes a day: the 4th earned
 *     push is held back, and its row still lands (bell + needs-you);
 *   - "something broke" (`work-broke`) is exempt: it pushes past the cap and
 *     is never counted;
 *   - the day is the person's own: yesterday's pushes do not count;
 *   - a per-type "all" rule (the person's own ask) still pushes past the cap.
 *
 * Real: `NotificationService.create`, `push-decision.ts` (the count and the
 * `pushed_at` record), the tables. Stubbed: Expo + socket (captured), the
 * side-effect emitters.
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
import { notifications, notificationPreferences, users } from "@synap/database";
import { PUSH_DAILY_CAP } from "@synap-core/types/push";
import { NotificationService } from "../NotificationService.js";
import { decidePush, withinPushCap } from "../push-decision.js";

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

/** A status signal: pushes under `late-or-stuck`, inside the cap. */
const signal = (n: number) =>
  NotificationService.create({
    type: "entity.signal",
    userId: USER,
    workspaceId: null,
    sourceType: "entity",
    sourceId: randomUUID(),
    groupKey: `status-signal:late:invoice:${n}`,
    data: { headline: `Invoice ${n} is late`, detail: "Its due date passed." },
  });

/** Something broke: `agent.task_failed` is `work-broke`, exempt. */
const broke = () =>
  NotificationService.create({
    type: "agent.task_failed",
    userId: USER,
    workspaceId: null,
    sourceType: "agent",
    sourceId: randomUUID(),
    data: { agentName: `agent-${randomUUID().slice(0, 4)}`, error: "boom" },
  });

describe("the daily push cap", () => {
  beforeAll(async () => {
    for (const t of [notifications, notificationPreferences, users]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `alter table notifications alter column status set default 'unread'`
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
    h.pushes.length = 0;
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  it(`the ${PUSH_DAILY_CAP + 1}th push of a day is held back; its row still lands`, async () => {
    for (let n = 1; n <= PUSH_DAILY_CAP + 1; n++) await signal(n);
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP);
    const rows = await q<{ title: string; pushed: boolean; status: string }>(
      `select title, pushed_at is not null as pushed, status from notifications order by created_at`
    );
    expect(rows.rows).toHaveLength(PUSH_DAILY_CAP + 1);
    expect(rows.rows.filter((r) => r.pushed)).toHaveLength(PUSH_DAILY_CAP);
    // The held-back one is unread in the bell (and so in needs-you).
    const held = rows.rows.find((r) => !r.pushed)!;
    expect(held).toMatchObject({
      title: "Invoice 4 is late",
      status: "unread",
    });
  });

  it("'something broke' pushes past the cap and is never counted", async () => {
    for (let n = 1; n <= PUSH_DAILY_CAP; n++) await signal(n);
    await broke();
    await broke();
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP + 2);
    // Exempt pushes are not counted: had they been, this one would be held.
    expect(
      withinPushCap(
        decidePush({
          type: "agent.task_failed",
          typeRule: undefined,
          facts: {},
          prefs: {},
        }),
        99
      )
    ).toMatchObject({ push: true, category: "work-broke" });
  });

  it("the day is the person's own: yesterday's pushes do not count", async () => {
    for (let n = 1; n <= PUSH_DAILY_CAP; n++) await signal(n);
    await q(
      `update notifications set pushed_at = now() - interval '1 day 1 hour'`
    );
    h.pushes.length = 0;
    await signal(9);
    expect(h.pushes).toHaveLength(1);
  });

  it("a per-type 'all' rule (the person's own ask) still pushes past the cap", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules, push_prefs) values ($1, $2, null, true, $3::jsonb, '{}'::jsonb)`,
      [randomUUID(), USER, JSON.stringify({ "entity.signal": "all" })]
    );
    for (let n = 1; n <= PUSH_DAILY_CAP + 1; n++) await signal(n);
    expect(h.pushes).toHaveLength(PUSH_DAILY_CAP + 1);
  });

  it("a timezone nobody knows reads as UTC: the cap holds and 'broke' still pushes", async () => {
    await q(`update users set timezone = 'Mars/Olympus_Mons' where id = $1`, [
      USER,
    ]);
    try {
      for (let n = 1; n <= PUSH_DAILY_CAP + 1; n++) await signal(n);
      await broke();
      expect(h.pushes).toHaveLength(PUSH_DAILY_CAP + 1);
      expect(h.pushes.at(-1)).toMatchObject({
        data: { type: "agent.task_failed" },
      });
    } finally {
      await q(`update users set timezone = 'UTC' where id = $1`, [USER]);
    }
  });
});
