/**
 * A HOLD ON A THING'S MOVE heals itself (finding 4302f124, dogfood 27 Nov
 * 2026: a session paused on `focus_session:A` stayed paused after A ended).
 *
 * The reactor sends ONE `awaiting` job per move of the awaited thing. Lose it
 * (a delivery that failed, a process without the reactor) or record the pause
 * after the move, and nothing else read those holds: the hourly sweep knew
 * dated, dev and wait holds only. Here the move's own wake is never sent, and
 * the sweep (or the pause's own check) must release the holder from the
 * transition log, once, with the reactor's own `until.to` / category rule.
 *
 * Real: `listHolds`, `listSubjectMoves`, `setSessionStatus` (the outbox is the
 * log the holds and the moves are read from). Stubbed: the event delivery
 * (`@synap/events`); the api's follow-up (the wake) is recorded.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  followUps: [] as Array<Record<string, unknown>>,
  /** The next read of a thing's moves fails (a read failure, not "no move"). */
  failMovesRead: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const listSubjectMoves = actual.listSubjectMoves as (
    ...args: unknown[]
  ) => Promise<unknown>;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    listSubjectMoves: async (...args: unknown[]) => {
      if (h.failMovesRead) {
        h.failMovesRead = false;
        throw new Error("connection reset");
      }
      return listSubjectMoves(...args);
    },
    EventRepository: class {
      async append() {
        return {};
      }
    },
  };
});

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: async () => "job" }),
  dispatchLifecycleTransition: vi.fn(async () => true),
  emitSideEffects: vi.fn(async () => {}),
  registerReactor: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  events,
  focusSessions,
  lifecycleTransitionOutbox,
  projectTracks,
  projects,
  proposals,
} from "@synap/database/schema";
import { db, setSessionStatus } from "@synap/database";
import type { Hold } from "@synap-core/types/lifecycle";
import {
  HOLD_RESUME_QUEUE,
  handleHoldResume,
  holdResumeReactor,
  registerHoldResumeFollowUp,
  type HoldResumeJobData,
} from "./hold-resume.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const HUMAN = { kind: "human" as const, userId: "u1" };
const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };
const DAY = 86_400_000;

async function session(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, updated_at) values ($1, 'u1', 'g', $2, now() - interval '3 days')`,
    [id, status]
  );
  return id;
}
const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;
const lastOwed = async (id: string) =>
  (
    await q<{ transition: Record<string, unknown> }>(
      `select transition from lifecycle_transition_outbox
        where transition->>'subjectId' = $1
        order by (transition->>'recordedAt') desc limit 1`,
      [id]
    )
  ).rows[0]!.transition;

async function pause(id: string, until: Hold["until"], wake = false) {
  await setSessionStatus(db, {
    sessionId: id,
    from: "active",
    to: "paused",
    actor: AGENT,
    hold: { on: "thing", until, ...(wake ? { wake: true } : {}) },
  });
}

/** A move of an entity, as `applyStatusMove` owes it (only the log is read). */
async function entityMoved(
  entityId: string,
  to: string,
  category: string,
  at = new Date()
) {
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at)
     values ($1, $2::jsonb, $3)`,
    [
      randomUUID(),
      JSON.stringify({
        subjectType: "entity",
        subjectId: entityId,
        entityId,
        from: "open",
        to,
        category,
        hold: null,
        recordedAt: at.toISOString(),
        occurredAt: at.toISOString(),
      }),
      at,
    ]
  );
}

/** The reactor, as the delivery of a transition runs it; returns its sends. */
async function deliver(subjectId: string, transition: Record<string, unknown>) {
  const sent: Array<{ queue: string; data: HoldResumeJobData; opts: unknown }> =
    [];
  const boss = {
    send: async (queue: string, data: HoldResumeJobData, opts: unknown) =>
      void sent.push({ queue, data, opts }),
  };
  await holdResumeReactor.handler(
    {
      subjectType: transition.subjectType,
      subjectId,
      action: "transition",
      eventId: transition.transitionId,
      // As `emitLifecycleTransition` fans a session's move out: the transition.
      data: { ...transition },
    } as never,
    { boss } as never
  );
  return sent;
}

const followUpsOf = (id: string) =>
  h.followUps.filter((f) => f.subjectId === id);

beforeAll(async () => {
  registerHoldResumeFollowUp(async (r) => {
    h.followUps.push(r);
  });
  for (const t of [
    events,
    focusSessions,
    lifecycleTransitionOutbox,
    projects,
    projectTracks,
    proposals,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

describe("the awaited move's wake was lost: the hourly sweep resumes the holder", () => {
  it("a session paused on another session's move resumes, and is woken, exactly once", async () => {
    const awaited = await session();
    const holder = await session();
    await pause(holder, { moves: `focus_session:${awaited}` }, true);
    const pauseRow = await lastOwed(holder);
    // Nothing moved yet: the sweep leaves it paused.
    expect((await handleHoldResume({})).resumed).toBe(0);
    expect(await statusOf(holder)).toBe("paused");

    // A ends; its transition's delivery to the reactor is LOST (never run).
    await setSessionStatus(db, {
      sessionId: awaited,
      from: "active",
      to: "closed",
      actor: AGENT,
    });
    expect(await statusOf(holder)).toBe("paused");

    expect((await handleHoldResume({})).resumed).toBe(1);
    expect(await statusOf(holder)).toBe("active");
    expect(await lastOwed(holder)).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "system",
      reason: `What it waited on (focus_session:${awaited}) moved to closed.`,
    });
    // The api's follow-up (which wakes the holder when `wake` asks) ran once,
    // with the hold and the pause it ends.
    expect(followUpsOf(holder)).toHaveLength(1);
    expect(followUpsOf(holder)[0]).toMatchObject({
      from: "paused",
      to: "active",
      hold: { wake: true, until: { moves: `focus_session:${awaited}` } },
      holdTransitionId: pauseRow.transitionId,
    });

    // The next tick, and the reactor's late send of the same move: nothing
    // is held any more, no second resume, no second wake.
    expect((await handleHoldResume({})).resumed).toBe(0);
    expect(
      (
        await handleHoldResume({
          awaiting: {
            subjectType: "focus_session",
            subjectId: awaited,
            to: "closed",
            category: "done",
          },
        })
      ).resumed
    ).toBe(0);
    expect(followUpsOf(holder)).toHaveLength(1);
  });

  it("an entity hold resumes only on a move that lands on `to`, as a status or as a category", async () => {
    const onStatus = randomUUID();
    const onCategory = randomUUID();
    const waitsStatus = await session();
    const waitsCategory = await session();
    await pause(waitsStatus, { moves: `entity:${onStatus}`, to: "shipped" });
    await pause(waitsCategory, { moves: `entity:${onCategory}`, to: "done" });

    // Moves that are not the awaited ones resume nothing.
    await entityMoved(onStatus, "in_review", "active");
    await entityMoved(onCategory, "in_review", "active");
    expect((await handleHoldResume({})).resumed).toBe(0);
    expect(await statusOf(waitsStatus)).toBe("paused");
    expect(await statusOf(waitsCategory)).toBe("paused");

    // `to` named by its status key; `to: done` met by a status of that category.
    await entityMoved(onStatus, "shipped", "done");
    await entityMoved(onCategory, "accepted", "done");
    expect((await handleHoldResume({})).resumed).toBe(2);
    expect(await statusOf(waitsStatus)).toBe("active");
    expect(await statusOf(waitsCategory)).toBe("active");
    expect((await lastOwed(waitsCategory)).reason).toBe(
      `What it waited on (entity:${onCategory}) moved to accepted.`
    );
  });

  it("a move the thing made BEFORE the pause is not the move it waits for, unless the thing has ended", async () => {
    const thing = randomUUID();
    const holder = await session();
    await entityMoved(thing, "in_review", "active", new Date(Date.now() - DAY));
    await pause(holder, { moves: `entity:${thing}` });
    expect((await handleHoldResume({})).resumed).toBe(0);
    expect(await statusOf(holder)).toBe("paused");
  });

  it("a failed read of the moves is a failed sweep, never 'nothing to resume': the dated holds still resume, the next tick resumes the holder", async () => {
    const awaited = await session();
    const holder = await session();
    const dated = await session();
    await pause(holder, { moves: `focus_session:${awaited}` });
    await setSessionStatus(db, {
      sessionId: dated,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: {
        on: "person",
        until: { date: new Date(Date.now() + DAY).toISOString() },
      },
    });
    await setSessionStatus(db, {
      sessionId: awaited,
      from: "active",
      to: "cancelled",
      actor: AGENT,
    });

    h.failMovesRead = true;
    await expect(
      handleHoldResume({}, new Date(Date.now() + 2 * DAY))
    ).rejects.toThrow("connection reset");
    expect(await statusOf(dated)).toBe("active");
    expect(await statusOf(holder)).toBe("paused");

    expect((await handleHoldResume({})).resumed).toBe(1);
    expect(await statusOf(holder)).toBe("active");
  });
});

describe("a pause recorded AFTER the awaited thing ended", () => {
  it("the pause's own transition asks for the check: the holder resumes at once", async () => {
    const awaited = await session();
    await setSessionStatus(db, {
      sessionId: awaited,
      from: "active",
      to: "cancelled",
      actor: AGENT,
    });
    const holder = await session();
    await pause(holder, { moves: `focus_session:${awaited}` }, true);

    const sent = await deliver(holder, await lastOwed(holder));
    const check = sent.find((s) => s.data.pausedOn);
    expect(check).toMatchObject({
      queue: HOLD_RESUME_QUEUE,
      data: { pausedOn: `focus_session:${awaited}` },
      opts: {
        singletonKey: `hold-resume:paused-on:${(await lastOwed(holder)).transitionId}`,
      },
    });
    expect((await handleHoldResume(check!.data)).resumed).toBe(1);
    expect(await statusOf(holder)).toBe("active");
    expect((await lastOwed(holder)).reason).toBe(
      `What it waited on (focus_session:${awaited}) was already cancelled.`
    );
    expect(followUpsOf(holder)).toHaveLength(1);
  });

  it("with `to`, only a thing already standing there releases it", async () => {
    const thing = randomUUID();
    await entityMoved(thing, "in_review", "active", new Date(Date.now() - DAY));
    const notThere = await session();
    const there = await session();
    await pause(notThere, { moves: `entity:${thing}`, to: "done" });
    await pause(there, { moves: `entity:${thing}`, to: "in_review" });
    expect(
      (await handleHoldResume({ pausedOn: `entity:${thing}` })).resumed
    ).toBe(1);
    expect(await statusOf(notThere)).toBe("paused");
    expect(await statusOf(there)).toBe("active");
  });

  it("a pause on anything else (a date, a wait) asks for no such check", async () => {
    const holder = await session();
    await setSessionStatus(db, {
      sessionId: holder,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: {
        on: "person",
        until: { date: new Date(Date.now() + DAY).toISOString() },
      },
    });
    const sent = await deliver(holder, await lastOwed(holder));
    expect(sent.filter((s) => s.data.pausedOn)).toEqual([]);
  });
});

describe("end to end: the awaited session's real transition, through the reactor", () => {
  it("A's own outbox transition, delivered to the reactor, resumes the holder", async () => {
    const awaited = await session();
    const holder = await session();
    await pause(holder, { moves: `focus_session:${awaited}` });
    await setSessionStatus(db, {
      sessionId: awaited,
      from: "active",
      to: "closed",
      actor: AGENT,
    });
    // What the sweeper delivers: A's transition as the outbox holds it.
    const sent = await deliver(awaited, await lastOwed(awaited));
    const jobs = sent.filter((s) => s.queue === HOLD_RESUME_QUEUE);
    expect(jobs.map((s) => s.data)).toContainEqual({
      awaiting: {
        subjectType: "focus_session",
        subjectId: awaited,
        to: "closed",
        category: "done",
      },
    });
    let resumed = 0;
    for (const job of jobs)
      resumed += (await handleHoldResume(job.data)).resumed;
    expect(resumed).toBe(1);
    expect(await statusOf(holder)).toBe("active");
  });
});
