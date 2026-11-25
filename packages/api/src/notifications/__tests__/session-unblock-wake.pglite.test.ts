/**
 * THE WAKE (founder P3) — on PGlite: the REAL `session-unblock-notify`
 * reactor, the REAL dependency reads, the REAL session status write
 * (`setSessionStatus`, compare-and-set + its transition row) and the REAL
 * hourly sweep (`sweepPlannedSessions`). Only the notification write is
 * captured.
 *
 * A PLANNED step (`forming`) whose LAST blocker delivers moves to `active`,
 * once, with one audit line, and starts `startedAt` then. Nothing else moves.
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
import {
  PLANNED_WAKE_SETTLE_MINUTES,
  sweepPlannedSessions,
  wakePlannedSession,
} from "../../services/focus-sessions/planned-wake.js";

const OWNER = "user-planner";
const BORN = "2026-01-05T09:00:00.000Z";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(
  title: string,
  status: string,
  opts: { metadata?: Record<string, unknown>; createdAgo?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, metadata, started_at, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, $6::jsonb, $7, now() - $8::interval, now() - $8::interval)`,
    [
      id,
      OWNER,
      title,
      title,
      status,
      JSON.stringify(opts.metadata ?? {}),
      BORN,
      opts.createdAgo ?? "2 hours",
    ]
  );
  return id;
}

async function decision(status: string, category: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, status, status_category, properties, system_data)
     values ($1, $2, null, 'decision', 'Raise or bootstrap', $3, $4, '{}'::jsonb, '{}'::jsonb)`,
    [id, OWNER, status, category]
  );
  return id;
}

async function waitsOn(from: string, toType: string, to: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_at)
     values (gen_random_uuid(), 'session', $1, $2, $3, 'blocked_by', now())`,
    [from, toType, to]
  );
}

async function row(id: string) {
  const [r] = (
    await q<{ status: string; started_at: string | Date }>(
      `select status, started_at from focus_sessions where id = $1`,
      [id]
    )
  ).rows;
  return {
    status: r!.status,
    startedAt: new Date(r!.started_at).toISOString(),
  };
}

async function transitionsOf(id: string) {
  return (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [id]
    )
  ).rows.map((r) => r.transition);
}

async function decisionAccepted(entityId: string) {
  const ev = {
    subjectType: "entity",
    action: "transition",
    subjectId: entityId,
    userId: OWNER,
    workspaceId: null,
    data: {
      entityId,
      profileSlug: "decision",
      lifecycleProfile: "decision",
      role: null,
      from: "proposed",
      to: "accepted",
      category: "done",
    },
  } as never;
  expect(sessionUnblockNotifyReactor.match!(ev)).toBe(true);
  await sessionUnblockNotifyReactor.handler(ev, {} as never);
}

async function sessionClosed(sessionId: string) {
  const ev = {
    subjectType: "focus_session",
    action: "closed",
    subjectId: sessionId,
    userId: OWNER,
    workspaceId: null,
    data: { sessionId },
  } as never;
  expect(sessionUnblockNotifyReactor.match!(ev)).toBe(true);
  await sessionUnblockNotifyReactor.handler(ev, {} as never);
}

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'p@x.test')`, [OWNER]);
});

beforeEach(() => {
  h.created.length = 0;
});

describe("the wake on the LAST blocker (reactor)", () => {
  it("a decision accepted wakes the planned step: active, startedAt now, one audit line", async () => {
    const d = await decision("accepted", "done");
    const step = await session("Send the term sheet", "forming");
    await waitsOn(step, "entity", d);

    await decisionAccepted(d);

    const after = await row(step);
    expect(after.status).toBe("active");
    // Rules out: the start keeps its birth date (the needs-you Stopped clock
    // would read a step woken today as quiet for months).
    expect(after.startedAt > BORN).toBe(true);
    const moves = await transitionsOf(step);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "forming", to: "active" });
    expect(String(moves[0]!.reason)).toMatch(/last blocker delivered/);
    // The notification is still the news.
    expect(h.created.map((c) => c.type)).toEqual(["session.unblocked"]);
  });

  it("a delivered session blocker wakes it too (the close arm)", async () => {
    const blocker = await session("Due diligence", "closed");
    const step = await session("Close the round", "forming");
    await waitsOn(step, "session", blocker);

    await sessionClosed(blocker);

    expect((await row(step)).status).toBe("active");
  });

  it("stays planned while another blocker still holds it (rules out 'a blocker ended, so it starts')", async () => {
    const d = await decision("accepted", "done");
    const other = await session("Pick the lead", "active");
    const step = await session("Sign", "forming");
    await waitsOn(step, "entity", d);
    await waitsOn(step, "session", other);

    await decisionAccepted(d);

    expect((await row(step)).status).toBe("forming");
    expect(await transitionsOf(step)).toHaveLength(0);
  });

  it("stays planned until its date (rules out 'blockers alone wake it')", async () => {
    const d = await decision("accepted", "done");
    const step = await session("Board meeting", "forming", {
      metadata: { plannedFor: "2099-01" },
    });
    await waitsOn(step, "entity", d);

    await decisionAccepted(d);

    expect((await row(step)).status).toBe("forming");
  });

  it("never moves a step that is not planned (rules out 'wake = set active')", async () => {
    const d = await decision("accepted", "done");
    const paused = await session("Held work", "paused");
    await waitsOn(paused, "entity", d);

    await decisionAccepted(d);

    expect((await row(paused)).status).toBe("paused");
    expect(await transitionsOf(paused)).toHaveLength(0);
  });
});

describe("the hourly sweep (the net, and the waker of a date)", () => {
  it("wakes what is ready, leaves what waits, a dropped blocker and a step just born", async () => {
    await q(
      `update focus_sessions set status = 'closed' where status = 'forming'`
    );
    const ready = await session("Nothing holds me", "forming");
    const dated = await session("My month came", "forming", {
      metadata: { plannedFor: "2026-01" },
    });
    const future = await session("Next year", "forming", {
      metadata: { plannedFor: "2099-03-01" },
    });
    const cancelled = await session("Dropped work", "cancelled");
    const dropped = await session("Waits on dropped", "forming");
    await waitsOn(dropped, "session", cancelled);
    const young = await session("Just born", "forming", {
      createdAgo: `${PLANNED_WAKE_SETTLE_MINUTES - 5} minutes`,
    });

    const woken = await sweepPlannedSessions();

    expect(woken).toBe(2);
    expect((await row(ready)).status).toBe("active");
    expect((await row(dated)).status).toBe("active");
    expect((await row(future)).status).toBe("forming");
    // A dropped blocker never wakes: the owner re-plans.
    expect((await row(dropped)).status).toBe("forming");
    // Its birth door writes its blockers just after the row.
    expect((await row(young)).status).toBe("forming");
  });

  it("a second wake is a no-op (compare-and-set from forming)", async () => {
    const step = await session("Once", "forming");
    expect(await wakePlannedSession({ sessionId: step, reason: "test" })).toBe(
      "woken"
    );
    expect(await wakePlannedSession({ sessionId: step, reason: "test" })).toBe(
      "not_planned"
    );
    expect(await transitionsOf(step)).toHaveLength(1);
  });
});
