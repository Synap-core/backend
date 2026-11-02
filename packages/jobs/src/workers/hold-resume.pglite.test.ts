/**
 * HOLD RESUME on PGlite (status-flow W4): the hourly sweep and the reactor's
 * job move a held thing back to the status its pause began from, as the
 * system, through its own write — and leave alone what is not due.
 *
 * Real: `listHolds`, `setSessionStatus`, `TrackRepository.transitionStatus`
 * (the outbox is the log the holds are read from). Stubbed: the event
 * delivery (`@synap/events`) and the goal receipt's event repository.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  emitted: [] as Array<Record<string, unknown>>,
  followUps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    // The goal's receipt (`track.update.completed`) needs no log here.
    EventRepository: class {
      async append() {
        return {};
      }
    },
  };
});

vi.mock("@synap/events", () => ({
  dispatchLifecycleTransition: vi.fn(async () => true),
  emitSideEffects: vi.fn(async (p: Record<string, unknown>) => {
    h.emitted.push(p);
  }),
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
import {
  db,
  HoldRefusedError,
  setSessionStatus,
  TrackRepository,
} from "@synap/database";
import {
  HOLD_RESUME_QUEUE,
  handleHoldResume,
  holdResumeReactor,
  registerHoldResumeFollowUp,
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
const DAY = 86_400_000;
const SOON = new Date(Date.now() + DAY).toISOString();
const AFTER = new Date(Date.now() + 2 * DAY);

async function session(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, updated_at) values ($1, 'u1', 'g', $2, now() - interval '3 days')`,
    [id, status]
  );
  return id;
}
const statusOf = async (table: string, id: string) =>
  (
    await q<{ status: string }>(`select status from ${table} where id = $1`, [
      id,
    ])
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

beforeAll(async () => {
  // The api's follow-ups (judgement notices, stale runs), recorded.
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

describe("the hourly sweep (until.date)", () => {
  it("resumes a session whose hold date has come, as the system, and only that one", async () => {
    const due = await session();
    const notYet = await session();
    const idle = await session();
    await setSessionStatus(db, {
      sessionId: due,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: { on: "person", until: { date: SOON } },
    });
    await setSessionStatus(db, {
      sessionId: notYet,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: {
        on: "person",
        until: { date: new Date(Date.now() + 5 * DAY).toISOString() },
      },
    });
    await setSessionStatus(db, {
      sessionId: idle,
      from: "active",
      to: "stale",
      actor: { kind: "system" },
      defaultHold: { on: "nobody", reason: "idle" },
    });

    // Before the date: nothing moves.
    expect(await handleHoldResume({}, new Date())).toEqual({
      resumed: 0,
      skipped: 0,
    });
    expect(await statusOf("focus_sessions", due)).toBe("paused");

    const r = await handleHoldResume({}, AFTER);
    expect(r.resumed).toBe(1);
    expect(await statusOf("focus_sessions", due)).toBe("active");
    expect(await statusOf("focus_sessions", notYet)).toBe("paused");
    expect(await statusOf("focus_sessions", idle)).toBe("stale");
    expect(await lastOwed(due)).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "system",
      hold: null,
    });
    // The api's follow-up ran for it (as the doors' own moves do).
    expect(h.followUps).toContainEqual(
      expect.objectContaining({
        subjectType: "focus_session",
        subjectId: due,
        from: "paused",
        to: "active",
      })
    );
    // Resumed once: the next tick finds nothing.
    expect((await handleHoldResume({}, AFTER)).resumed).toBe(0);
  });

  it("resumes a goal and clears the check gate's marker", async () => {
    const projectId = randomUUID();
    const trackId = randomUUID();
    await q(`insert into projects (id, user_id, name) values ($1, 'u1', 'p')`, [
      projectId,
    ]);
    await q(
      `insert into project_tracks (id, project_id, user_id, name, status, metadata) values ($1, $2, 'u1', 'g', 'active', '{"checkGate":{"stageKey":"s"}}'::jsonb)`,
      [trackId, projectId]
    );
    await new TrackRepository(db, {
      append: async () => ({}),
    } as never).transitionStatus(
      trackId,
      {
        from: "active",
        to: "paused",
        actor: HUMAN,
        hold: { on: "external", until: { date: SOON } },
      },
      "u1"
    );
    expect(await statusOf("project_tracks", trackId)).toBe("paused");
    await handleHoldResume({}, AFTER);
    expect(await statusOf("project_tracks", trackId)).toBe("active");
    const [row] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    expect(row!.metadata).not.toHaveProperty("checkGate");
    expect(h.followUps).toContainEqual(
      expect.objectContaining({ subjectType: "track", subjectId: trackId })
    );
    expect(h.emitted.at(-1)).toMatchObject({
      subjectType: "track",
      action: "update",
      subjectId: trackId,
    });
  });
});

// Review 459d5e5b: one hold with a bad stored date failed the whole hourly
// sweep (a `::timestamptz` cast of every row in SQL; `new Date(NaN)` in the
// dev-fact read). Each row is decided on its own: a bad one is skipped and
// logged, the others resume.
describe("the hourly sweep isolates a bad row", () => {
  const corrupt = (id: string, path: string, value: string) =>
    q(
      `update lifecycle_transition_outbox
          set transition = jsonb_set(transition, $2::text[], to_jsonb($3::text))
        where transition->>'subjectId' = $1 and transition->>'to' = 'paused'`,
      [id, path, value]
    );
  async function pausedUntil(until: Record<string, unknown>) {
    const id = await session();
    await setSessionStatus(db, {
      sessionId: id,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: { on: "external", until } as never,
    });
    return id;
  }

  it("a hold whose until.date does not parse is skipped; the due ones still resume", async () => {
    const good = await pausedUntil({ date: SOON });
    const bad = await pausedUntil({ date: SOON });
    await corrupt(bad, "{hold,until,date}", "not-a-date");
    expect((await lastOwed(bad)).hold).toMatchObject({
      until: { date: "not-a-date" },
    });
    await handleHoldResume({}, AFTER);
    expect(await statusOf("focus_sessions", good)).toBe("active");
    expect(await statusOf("focus_sessions", bad)).toBe("paused");
  });

  it("a dev hold whose pause start does not parse is skipped; the other dev holds are still decided", async () => {
    const REPO = "acme/isolation";
    const good = await pausedUntil({ moves: `main:${REPO}` });
    const bad = await pausedUntil({ moves: `main:${REPO}` });
    await corrupt(bad, "{hold,since}", "garbage");
    const at = new Date(Date.now() + 1_000);
    await q(
      `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
       values ($1, 'dev.repo_snapshot', 'u1', $2, 'observation', $3::jsonb, $4)`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          repo: REPO,
          observedAt: at.toISOString(),
          main: { health: "ok" },
        }),
        at,
      ]
    );
    await handleHoldResume({}, new Date(Date.now() + 2_000));
    expect(await statusOf("focus_sessions", good)).toBe("active");
    expect(await statusOf("focus_sessions", bad)).toBe("paused");
  });
});

describe("the awaited thing moved (until.moves)", () => {
  it("resumes what waited on it, only when it reached the awaited status", async () => {
    const awaited = await session();
    const waiter = await session();
    await setSessionStatus(db, {
      sessionId: waiter,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: {
        on: "thing",
        until: { moves: `focus_session:${awaited}`, to: "done" },
      },
    });
    const moved = (to: string, category: string) => ({
      awaiting: {
        subjectType: "focus_session",
        subjectId: awaited,
        to,
        category,
      },
    });
    // A move that is not the awaited one wakes nothing.
    expect((await handleHoldResume(moved("paused", "paused"))).resumed).toBe(0);
    expect(await statusOf("focus_sessions", waiter)).toBe("paused");

    expect((await handleHoldResume(moved("closed", "done"))).resumed).toBe(1);
    expect(await statusOf("focus_sessions", waiter)).toBe("active");
    expect(await lastOwed(waiter)).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "system",
      reason: `What it waited on (focus_session:${awaited}) moved to closed.`,
    });
  });
});

describe("a dev fact (until.moves = pr: / main: / job:)", () => {
  const PR_REF = "pr:synap-core/backend#47";
  const BE = "Synap-core/backend";
  async function devFact(
    user: string,
    type: string,
    data: Record<string, unknown>,
    at = new Date(Date.now() + 1_000)
  ) {
    await q(
      `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
       values ($1, $2, $3, $4, 'observation', $5::jsonb, $6)`,
      [randomUUID(), type, user, randomUUID(), JSON.stringify(data), at]
    );
  }
  async function pausedOn(moves: string, to?: string): Promise<string> {
    const id = await session();
    await setSessionStatus(db, {
      sessionId: id,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: { on: "external", until: { moves, ...(to ? { to } : {}) } },
    });
    return id;
  }

  it("the fact's job resumes the hold that names it, once the owner's fact is in", async () => {
    const waiter = await pausedOn("pr:Synap-core/Backend#47");
    // Recorded in ONE spelling, so the fact's ref finds it.
    expect((await lastOwed(waiter)).hold).toMatchObject({
      until: { moves: PR_REF },
    });
    const pr = {
      repo: BE,
      number: 47,
      url: `https://github.com/${BE}/pull/47`,
    };

    // No fact yet; then another person's merge: nothing moves.
    expect((await handleHoldResume({ devFact: PR_REF })).resumed).toBe(0);
    await devFact("u2", "dev.pr_merged", { ...pr, intoDefault: true });
    expect((await handleHoldResume({ devFact: PR_REF })).resumed).toBe(0);
    expect(await statusOf("focus_sessions", waiter)).toBe("paused");

    await devFact("u1", "dev.pr_merged", { ...pr, intoDefault: true });
    expect((await handleHoldResume({ devFact: PR_REF })).resumed).toBe(1);
    expect(await statusOf("focus_sessions", waiter)).toBe("active");
    expect(await lastOwed(waiter)).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "system",
      reason: `What it waited on (${PR_REF}) is in.`,
    });
  });

  it("the hourly sweep decides every dev hold from one read per kind: each hold reads only its own owner's fact of its own ref", async () => {
    const a = await pausedOn(`pr:${BE}#61`);
    const b = await pausedOn(`pr:${BE}#62`);
    const c = await pausedOn(`pr:${BE}#63`);
    const merged = (user: string, number: number) =>
      devFact(user, "dev.pr_merged", {
        repo: BE,
        number,
        url: `https://github.com/${BE}/pull/${number}`,
        intoDefault: true,
      });
    await merged("u1", 61);
    await merged("u1", 62);
    // #63 merged, but the fact is another person's: it never moves u1's hold.
    await merged("u2", 63);
    expect((await handleHoldResume({}, new Date())).resumed).toBe(2);
    expect(await statusOf("focus_sessions", a)).toBe("active");
    expect(await statusOf("focus_sessions", b)).toBe("active");
    expect(await statusOf("focus_sessions", c)).toBe("paused");
  });

  it("the hourly sweep resumes a job hold whose run ended after the pause, and a main hold once main is green", async () => {
    const onJob = await pausedOn("job:dev-feed-h", "failed");
    const onMain = await pausedOn(`main:${BE}`);
    const ci = (status: string, at?: Date) =>
      devFact(
        "u1",
        "ci.finished",
        {
          repo: BE,
          sha: "a".repeat(40),
          status,
          workflow: "devbox dev-feed-h",
        },
        at
      );
    // A run of the same name BEFORE the pause, and a pass after it: the hold
    // waits for a failure.
    await ci("failure", new Date(Date.now() - DAY));
    await ci("success");
    const snapshot = (health: string, observedAt: Date) =>
      devFact(
        "u1",
        "dev.repo_snapshot",
        { repo: BE, observedAt: observedAt.toISOString(), main: { health } },
        observedAt
      );
    await snapshot("red", new Date(Date.now() + 1_000));
    expect((await handleHoldResume({}, new Date())).resumed).toBe(0);

    await ci("failure", new Date(Date.now() + 2_000));
    await snapshot("ok", new Date(Date.now() + 3_000));
    expect((await handleHoldResume({}, new Date())).resumed).toBe(2);
    expect(await statusOf("focus_sessions", onJob)).toBe("active");
    expect(await statusOf("focus_sessions", onMain)).toBe("active");
  });
});

// Plan 07f8a997 "Agents wait on anything", W1 part C: an agent asks, pauses
// with `until: answer:<session>/<slot>` or `proposal:<id>`, and sleeps.
describe("a wait on the person (until.moves = answer: / proposal:)", () => {
  const SLOT = {
    key: "host",
    label: "Founder picks a host",
    kind: "decision",
    owner: "human",
  };
  async function withSlot(user = "u1", answer?: Record<string, unknown>) {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, expected_outputs, updated_at)
       values ($1, $2, 'g', 'active', $3::jsonb, now())`,
      [id, user, JSON.stringify([{ ...SLOT, ...(answer ? { answer } : {}) }])]
    );
    return id;
  }
  const answered = (by = "u1") => ({
    text: "Hetzner",
    messageId: null,
    answeredBy: by,
    answeredAt: new Date().toISOString(),
  });
  const answer = (id: string, by: string) =>
    q(`update focus_sessions set expected_outputs = $2::jsonb where id = $1`, [
      id,
      JSON.stringify([{ ...SLOT, answer: answered(by) }]),
    ]);
  async function pauseOn(id: string, moves: string) {
    await setSessionStatus(db, {
      sessionId: id,
      from: "active",
      to: "paused",
      actor: { kind: "agent", userId: "u1", agentUserId: "a1" },
      hold: { on: "person", until: { moves } },
    });
  }
  async function proposal(sessionId: string, status = "pending") {
    const id = randomUUID();
    await q(
      `insert into proposals (id, target_type, proposal_type, data, status, session_id, created_at, updated_at)
       values ($1, 'entity', 'create', '{}'::jsonb, $2, $3, now(), now())`,
      [id, status, sessionId]
    );
    return id;
  }

  it("the answer's trigger resumes the session once its OWNER's answer is on the slot, by key or label", async () => {
    const waiter = await withSlot();
    await pauseOn(waiter, `answer:${waiter}/Founder picks a host`);
    const waits = { sessionId: waiter };
    expect((await handleHoldResume({ waits })).resumed).toBe(0);
    // Words on the slot from someone who is not the session's owner: not an answer.
    await answer(waiter, "u2");
    expect((await handleHoldResume({ waits })).resumed).toBe(0);
    expect(await statusOf("focus_sessions", waiter)).toBe("paused");
    await answer(waiter, "u1");
    // Another session's trigger does not touch it.
    expect(
      (await handleHoldResume({ waits: { sessionId: randomUUID() } })).resumed
    ).toBe(0);
    expect((await handleHoldResume({ waits })).resumed).toBe(1);
    expect(await statusOf("focus_sessions", waiter)).toBe("active");
    expect(await lastOwed(waiter)).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "system",
      reason: `The person answered what it waited on (answer:${waiter}/Founder picks a host).`,
    });
  });

  it("an answer given BEFORE the pause resumes it at once: the pause's own transition asks for the check (the Inngest trap)", async () => {
    const waiter = await withSlot("u1", answered());
    await pauseOn(waiter, `answer:${waiter}/host`);
    // The reactor sees the pause's transition: it sends the wait check.
    const sent: Array<{ queue: string; data: unknown }> = [];
    const boss = {
      send: async (queue: string, data: unknown) =>
        void sent.push({ queue, data }),
    };
    await holdResumeReactor.handler(
      {
        subjectType: "focus_session",
        subjectId: waiter,
        action: "transition",
        eventId: "e1",
        data: await lastOwed(waiter),
      } as never,
      { boss } as never
    );
    expect(sent).toContainEqual({
      queue: HOLD_RESUME_QUEUE,
      data: { waits: { sessionId: waiter } },
    });
    expect(
      (await handleHoldResume({ waits: { sessionId: waiter } })).resumed
    ).toBe(1);
    expect(await statusOf("focus_sessions", waiter)).toBe("active");
  });

  it("a proposal wait resumes once the proposal is no longer pending; the hourly sweep finds it too", async () => {
    const waiter = await session();
    const pid = await proposal(waiter);
    await pauseOn(waiter, `proposal:${pid}`);
    expect(
      (await handleHoldResume({ waits: { proposalId: pid } })).resumed
    ).toBe(0);
    await q(`update proposals set status = 'rejected' where id = $1`, [pid]);
    // The sweep (no data) re-checks every wait hold.
    expect((await handleHoldResume({}, AFTER)).resumed).toBeGreaterThanOrEqual(
      1
    );
    expect(await statusOf("focus_sessions", waiter)).toBe("active");
    expect((await lastOwed(waiter)).reason).toBe(
      `What it waited on (proposal:${pid}) was decided.`
    );
  });

  it("a wait on someone else's session, an undeclared slot or someone else's proposal is refused when it is set", async () => {
    const waiter = await session();
    const theirs = await withSlot("u2");
    const mine = await withSlot("u1");
    const theirProposal = await proposal(theirs);
    for (const moves of [
      `answer:${theirs}/host`,
      `answer:${mine}/no such slot`,
      `answer:${randomUUID()}/host`,
      `proposal:${theirProposal}`,
      `proposal:${randomUUID()}`,
    ]) {
      await expect(pauseOn(waiter, moves), moves).rejects.toBeInstanceOf(
        HoldRefusedError
      );
      expect(await statusOf("focus_sessions", waiter)).toBe("active");
    }
  });
});
