/**
 * `session.needs_you` in the needs-you union, driven through the REAL
 * `signals.count` and `signals.list` procedures on PGlite.
 *
 * Originally two bugs, both introduced by the room-first notifications
 * (2026-09-25):
 *  1. `session.room_update` (informational: low priority, in-app only) counted
 *     as needing you, like a real ask.
 *  2. `session.needs_you` announces the SAME need the owed-slot row shows, so
 *     one session counted twice, and it kept counting after the slot was met.
 *
 * `session.room_update` was later retired outright (founder decision F,
 * 2026-09-25): its producer (`notifyRoomPost`'s update branch) and its
 * registry row were both removed, so bug 1's fix is now moot in production —
 * a stray row of that type is kept below only to prove it fell back to an
 * ordinary, unsuppressed item, not that anything still writes it.
 *
 * Real: `signals.count` / `signals.list`, `notifCenter.list` (user floor +
 * unread filter), `focusSessions.owed` (`listOwedSlots`, the owed predicate),
 * the open-question read (`sessionsWithOpenQuestion`), the registry's
 * `needsYou` roles, the pure union. Tables come from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `proposals.groups`: the proposal half is not under test and needs the
 *    whole proposal schema. It returns an empty queue.
 *  - `countProjectSessionsAwaitingReview`: project-scope only.
 *
 * NOT covered: the per-project badge (`countByProject`) takes no notification
 * half at all (a container scope is proposals + owed only), so neither bug can
 * reach it. That is asserted below, not assumed.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
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
        focusSessions: actual.focusSessions as never,
        notifications: actual.notifications as never,
        messages: actual.messages as never,
      },
    }),
  };
});

vi.mock("./proposals.js", () => ({
  proposalsRouter: {
    createCaller: () => ({
      groups: async () => ({
        groups: [],
        distinct: 0,
        scanTruncated: false,
      }),
    }),
  },
}));

vi.mock("../services/projects/project-needs-you.js", () => ({
  countProjectSessionsAwaitingReview: async () => ({
    review: 0,
    truncated: false,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db, focusSessions, notifications, messages } from "@synap/database";
import { signalsRouter } from "./signals.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWED_SLOT = {
  kind: "document",
  label: "Stripe key",
  status: "pending",
  owner: "human",
  owedSince: "2026-09-25T10:00:00.000Z",
  why: "the live restricted key",
};

async function seedSession(
  opts: { owed?: boolean; channelId?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship billing', 'Ship billing', 'active', $3::jsonb, $4, '{}'::jsonb, '[]'::jsonb, $5, now(), now(), now())`,
    [
      id,
      USER,
      JSON.stringify(opts.owed ? [OWED_SLOT] : []),
      [],
      opts.channelId ?? null,
    ]
  );
  return id;
}

async function notify(
  type: string,
  sessionId: string,
  sourceType = "session"
): Promise<void> {
  await q(
    `insert into notifications (id, user_id, type, category, priority, title, body, source_type, source_id, actions, status, created_at)
     values ($1, $2, $3, 'ai', 'high', $4, '', $5, $6, '[]'::jsonb, 'unread', now())`,
    [
      randomUUID(),
      USER,
      type,
      `${type} for ${sessionId}`,
      sourceType,
      sessionId,
    ]
  );
}

async function question(
  channelId: string,
  opts: { answered?: boolean; kind?: string } = {}
): Promise<string> {
  const id = randomUUID();
  const roomPost: Record<string, unknown> = {
    kind: opts.kind ?? "question",
  };
  if (opts.answered) {
    roomPost.answer = {
      messageId: randomUUID(),
      answeredBy: USER,
      answeredAt: "2026-09-25T11:00:00.000Z",
      text: "here",
    };
  }
  await q(
    `insert into messages (id, channel_id, user_id, author_type, content, metadata, timestamp)
     values ($1, $2, $3, 'ai_agent', 'Which Stripe account?', $4::jsonb, now())`,
    [id, channelId, USER, JSON.stringify({ roomPost })]
  );
  return id;
}

const caller = () =>
  signalsRouter.createCaller({
    db,
    authenticated: true,
    userId: USER,
  } as never);
const count = () => caller().count({});
const list = () =>
  caller()
    .list({ lens: "needs-you" })
    .then((r) => r.signals);

describe("signals: session.needs_you in needs-you (session.room_update retired)", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, notifications, messages]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from notifications; delete from messages;"
    );
  });

  it("session.room_update is retired (founder decision F, 2026-09-25): no producer writes it, and a stray row of that type is now an ordinary item, not a suppressed one", async () => {
    const s = await seedSession();
    await notify("session.room_update", s);

    // It is no longer tagged "informational" in the registry (that row was
    // removed with its producer, `notifyRoomPost`'s update branch) — it
    // falls back to the ordinary "item" role, same as any unknown type.
    expect((await count()).needsYou).toBe(1);
    expect(await list()).toHaveLength(1);
  });

  it("session.needs_you + the owed slot it announced = ONE entry, counted once", async () => {
    const s = await seedSession({ owed: true });
    await notify("session.needs_you", s);

    const c = await count();
    expect(c.needsYou).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.notifications).toBe(0);

    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "owed-slot",
      target: { kind: "session", id: s },
    });
  });

  it("an owed slot AND an open question about it: still ONE entry, counted once", async () => {
    // The case that separates the fold from the stale rule. With no question,
    // an unfolded pointer row is dropped as stale anyway, so the test above
    // cannot tell whether the fold ran (a negative control that removed the
    // fold stayed green there). Here the session has a live question too, so
    // only the fold keeps the count at 1.
    const channelId = randomUUID();
    const s = await seedSession({ owed: true, channelId });
    await question(channelId);
    await notify("session.needs_you", s);

    const c = await count();
    expect(c.needsYou).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.notifications).toBe(0);
    expect((await list()).map((r) => r.kind)).toEqual(["owed-slot"]);
  });

  it("session.needs_you after the slot was met = 0, though the row is still unread", async () => {
    const s = await seedSession({ owed: true });
    await notify("session.needs_you", s);
    expect((await count()).needsYou).toBe(1);

    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [s, JSON.stringify([{ ...OWED_SLOT, status: "done" }])]
    );
    const unread = await q<{ n: number }>(
      `select count(*)::int as n from notifications where status = 'unread'`
    );
    expect(unread.rows[0]!.n).toBe(1);
    expect((await count()).needsYou).toBe(0);
    expect(await list()).toEqual([]);
  });

  it("session.needs_you for an open room question (no slot) counts 1; answered = 0", async () => {
    const channelId = randomUUID();
    const s = await seedSession({ channelId });
    const qid = await question(channelId);
    await notify("session.needs_you", s);

    expect((await count()).needsYou).toBe(1);
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "notification",
      target: { kind: "session", id: s },
    });

    await q(
      `update messages set metadata = jsonb_set(metadata, '{roomPost,answer}', $2::jsonb) where id = $1`,
      [
        qid,
        JSON.stringify({
          messageId: "m",
          answeredBy: USER,
          answeredAt: "t",
          text: "x",
        }),
      ]
    );
    expect((await count()).needsYou).toBe(0);
  });

  it("an agent UPDATE post in the room is not an open question", async () => {
    const channelId = randomUUID();
    const s = await seedSession({ channelId });
    await question(channelId, { kind: "update" });
    await notify("session.needs_you", s);

    expect((await count()).needsYou).toBe(0);
  });

  it("the fold is keyed on the registry role, never on the session id: session.unblocked stays", async () => {
    const s = await seedSession({ owed: true });
    await notify("session.unblocked", s, "system");
    await notify("session.needs_you", s);

    const c = await count();
    expect(c.blocked).toBe(1);
    expect(c.notifications).toBe(1);
    expect(c.needsYou).toBe(2);
    expect((await list()).map((r) => r.kind).sort()).toEqual([
      "notification",
      "owed-slot",
    ]);
  });

  it("the badge equals the list length across a mixed population", async () => {
    const owedS = await seedSession({ owed: true });
    const channelId = randomUUID();
    const askS = await seedSession({ channelId });
    await question(channelId);
    const metS = await seedSession();
    for (const s of [owedS, askS, metS]) {
      await notify("session.needs_you", s);
    }

    const c = await count();
    expect(c.needsYou).toBe(2);
    expect(await list()).toHaveLength(c.needsYou);
  });

  it("AI suggestions are their own bucket: never in needs-you, listed under lens suggestions", async () => {
    const s = await seedSession({ owed: true });
    await notify("ai.proactive.nudge", s, "ai_proactive");
    await notify("ai.proactive.suggestion", s, "ai_proactive");
    await notify("ai.proactive.health_check", s, "ai_proactive");

    const c = await count();
    expect(c.needsYou).toBe(1); // the owed slot only
    expect(c.notifications).toBe(0);
    expect(c.suggestions).toBe(3);

    expect((await list()).map((r) => r.kind)).toEqual(["owed-slot"]);
    const sugg = await caller()
      .list({ lens: "suggestions" })
      .then((r) => r.signals);
    expect(sugg).toHaveLength(3);
    expect(sugg.every((r) => r.kind === "notification")).toBe(true);
  });

  it("a project count carries no notification half, so neither type can reach it", async () => {
    const s = await seedSession({ owed: true });
    await q(`update focus_sessions set project_id = $2 where id = $1`, [
      s,
      "33333333-3333-4333-8333-333333333333",
    ]);
    await notify("session.needs_you", s);
    await notify("chat.mention", s);

    const [row] = await caller().countByProject({
      projectIds: ["33333333-3333-4333-8333-333333333333"],
    });
    expect(row).toMatchObject({ status: "ok" });
    const c = (row as { count: { needsYou: number; notifications: number } })
      .count;
    expect(c.notifications).toBe(0);
    expect(c.needsYou).toBe(1);
  });

  it("a container-scoped suggestions list is empty, never unnarrowed", async () => {
    const s = await seedSession();
    await notify("ai.proactive.nudge", s, "ai_proactive");
    const sugg = await caller()
      .list({
        lens: "suggestions",
        projectId: "33333333-3333-4333-8333-333333333333",
      })
      .then((r) => r.signals);
    expect(sugg).toEqual([]);
  });
});
