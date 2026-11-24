/**
 * An ENTITY delivering is one more blocker ending (pathway doors) — on
 * PGlite: the REAL `session-unblock-notify` reactor, the REAL dependency reads
 * (`openBlockerIds`, `readDependencyState` → `deriveOpenBlockers`), the REAL
 * entity access predicate for the blocker's name. Only the notification write
 * is captured (its own suite covers the door).
 *
 * A session waiting on a decision (`session --blocked_by--> entity`) is told
 * `session.unblocked` when the decision is ACCEPTED (a done category) and
 * nothing else holds it. Notification only: no status moves.
 *
 * Each case names the WRONG rule it rules out.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("@synap/events", () => ({
  registerReactor: () => {},
  emitSideEffects: async () => {},
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.created.push(input);
      return "n-1";
    },
  },
}));

import { allSchemaTables, pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { sessionUnblockNotifyReactor } from "../session-unblock-reactor.js";

const WAITER = "user-waiter";
const STRANGER = "user-stranger";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function decision(
  title: string,
  status: string,
  category: string,
  userId = WAITER
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, status, status_category, properties, system_data)
     values ($1, $2, null, 'decision', $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`,
    [id, userId, title, status, category]
  );
  return id;
}

async function session(title: string, status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, now(), now())`,
    [id, WAITER, title, title, status]
  );
  return id;
}

async function edge(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  linkType = "blocked_by"
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
    [fromType, fromId, toType, toId, linkType]
  );
}

/** The status door's emit for the kind's own move (`emitLifecycleTransition`). */
const moved = (
  entityId: string,
  to: string,
  category: string,
  role: string | null = null
) =>
  ({
    subjectType: "entity",
    action: "transition",
    subjectId: entityId,
    userId: WAITER,
    workspaceId: null,
    data: {
      entityId,
      profileSlug: "decision",
      lifecycleProfile: role ?? "decision",
      role,
      from: "proposed",
      to,
      category,
    },
  }) as never;

async function fire(entityId: string) {
  const [row] = (
    await q<{ status: string; status_category: string }>(
      `select status, status_category from entities where id = $1`,
      [entityId]
    )
  ).rows;
  const ev = moved(entityId, row!.status, row!.status_category);
  expect(sessionUnblockNotifyReactor.match!(ev)).toBe(true);
  await sessionUnblockNotifyReactor.handler(ev, {} as never);
}

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(pgliteTableDdl(t));
  await q(
    `insert into users (id, email) values ($1, 'w@x.test'), ($2, 's@x.test')`,
    [WAITER, STRANGER]
  );
});

beforeEach(() => {
  h.created.length = 0;
});

describe("an entity delivering — the one 'a blocker ended' rule", () => {
  it("matches only the kind's OWN move into a done category", () => {
    // Rules out: reacting to every entity move, to a lost one, or to a role's.
    const m = sessionUnblockNotifyReactor.match!;
    expect(m(moved("d", "accepted", "done"))).toBe(true);
    expect(m(moved("d", "rejected", "lost"))).toBe(false);
    expect(m(moved("d", "proposed", "open"))).toBe(false);
    expect(m(moved("d", "accepted", "done", "approval"))).toBe(false);
    expect(
      m({
        subjectType: "entity",
        action: "update",
        subjectId: "d",
        data: { profileSlug: "decision" },
      } as never)
    ).toBe(false);
  });

  it("an ACCEPTED decision that was the last blocker unblocks the session — session.unblocked", async () => {
    const blocker = await decision("Raise or bootstrap", "accepted", "done");
    const waiting = await session("Send the term sheet");
    await edge("session", waiting, "entity", blocker);

    await fire(blocker);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      type: "session.unblocked",
      userId: WAITER,
      sourceId: waiting,
      data: {
        sessionId: waiting,
        blockerEntityId: blocker,
        blockerTitle: "Raise or bootstrap",
      },
    });
  });

  it("stays SILENT while another blocker still holds the session", async () => {
    // Rules out: "a blocker ended, so it is free".
    const blocker = await decision(
      "Pick the lead investor",
      "accepted",
      "done"
    );
    const other = await session("Due diligence");
    const waiting = await session("Close the round");
    await edge("session", waiting, "entity", blocker);
    await edge("session", waiting, "session", other);

    await fire(blocker);

    expect(h.created).toHaveLength(0);
  });

  it("is idempotent per (session, decision): a redelivered event tells nobody twice", async () => {
    const blocker = await decision("Valuation cap", "accepted", "done");
    const waiting = await session("Sign the SAFE");
    await edge("session", waiting, "entity", blocker);
    // The reactor reads the durable notification row before writing.
    await fire(blocker);
    expect(h.created).toHaveLength(1);
    await q(
      `insert into notifications (id, user_id, type, group_key, title, created_at)
       values (gen_random_uuid(), $1, 'session.unblocked', $2, 'x', now())`,
      [WAITER, `session.unblocked:${waiting}:${blocker}`]
    );
    await fire(blocker);
    expect(h.created).toHaveLength(1);
  });

  it("the ROW is the authority: a stale event about a decision reopened since tells nobody", async () => {
    // Rules out: trusting the event payload over the row.
    const blocker = await decision("Hire a CFO", "proposed", "open");
    const waiting = await session("Budget the year");
    await edge("session", waiting, "entity", blocker);

    const ev = moved(blocker, "accepted", "done");
    await sessionUnblockNotifyReactor.handler(ev, {} as never);

    expect(h.created).toHaveLength(0);
  });

  it("a decision the waiting person cannot see does not free the session", async () => {
    const blocker = await decision("Board seat", "accepted", "done", STRANGER);
    const waiting = await session("Draft the side letter");
    await edge("session", waiting, "entity", blocker);

    await fire(blocker);

    // A hidden blocker still holds its dependent (`deriveOpenBlockers`): the
    // session is not told it is free by something it cannot see.
    expect(h.created).toHaveLength(0);
  });
});
