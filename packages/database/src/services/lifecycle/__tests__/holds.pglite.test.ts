/**
 * HOLDS AND OCCURRED TIME on a real Postgres (PGlite), status-flow W4:
 *  - an agent's pause without a hold is REFUSED and writes nothing (entity,
 *    goal, session);
 *  - a person's pause without one is recorded `unspecified` + `reviewBy`;
 *  - the move records `occurredAt` / `recordedAt` at the move, a backdated one
 *    marked;
 *  - THE CURRENT HOLD is read off the transition log (`listHolds`): the
 *    latest transition into the status the thing still stands in; a later
 *    move ends it; the reaper's `paused → stale` carries it; a status written
 *    outside the doors leaves none current;
 *  - the sweep's and the reactor's questions (`resumeDueBy`, `awaiting`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PgTable } from "drizzle-orm/pg-core";
import { HOLD_REQUIRED_MESSAGE } from "@synap-core/types/lifecycle";
import { ddlFor, makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import {
  applyStatusMove,
  resolveStatusMoveTarget,
} from "../apply-status-move.js";
import { setSessionStatus } from "../session-status.js";
import { HoldRefusedError, listHolds } from "../holds.js";
import { TrackRepository } from "../../../repositories/track-repository.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
let db: any;
let engagementKind: string;
let repo: TrackRepository;

const HUMAN = { kind: "human" as const, userId: "u1" };
const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };
const DAY = 86_400_000;
const LATER = new Date(Date.now() + 10 * DAY).toISOString();

const outboxCount = async (subjectId: string) =>
  (
    await h.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lifecycle_transition_outbox WHERE transition->>'subjectId' = $1`,
      [subjectId]
    )
  ).rows[0]!.n;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  for (const t of [
    schema.projects,
    schema.projectTracks,
    schema.focusSessions,
  ]) {
    await h.pg.exec(ddlFor(t as unknown as PgTable));
  }
  const [p] = await db
    .insert(schema.profiles)
    .values({
      slug: "engagement",
      displayName: "engagement",
      profileKind: "kind",
    })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "stage",
      valueType: "string",
      profileId: p.id,
      constraints: buildStoredConstraints({
        enumOptions: [
          { key: "proposed", category: "open" },
          { key: "running", category: "active" },
          { key: "on-hold", category: "paused" },
          { key: "waiting", category: "paused" },
          { key: "done", category: "done" },
        ],
      }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: "stage" });
  engagementKind = p.id;
  repo = new TrackRepository(db, { append: async () => ({}) } as never);
}, 120_000);
afterAll(async () => h?.pg.close());

async function engagement(status = "running") {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      profileId: engagementKind,
      type: "engagement",
      status,
      properties: { stage: status },
    })
    .returning();
  const r = await resolveStatusMoveTarget(db, { entityId: e.id });
  if (!r.ok) throw new Error(r.reason);
  return r.target;
}

const subjectOf = (entityId: string) => ({
  subjectType: "entity" as const,
  subjectId: entityId,
  facetId: null,
});

describe("entity pause (applyStatusMove)", () => {
  it("refuses an agent's pause without a hold: nothing moves, nothing is owed", async () => {
    const target = await engagement();
    const r = await applyStatusMove(db, {
      target,
      expectedFrom: "running",
      to: "on-hold",
      actor: AGENT,
    });
    expect(r).toEqual({
      status: "refused",
      code: "HOLD_REQUIRED",
      reason: HOLD_REQUIRED_MESSAGE,
    });
    const [row] = await h.pg
      .query<{ status: string }>(`SELECT status FROM entities WHERE id = $1`, [
        target.entityId,
      ])
      .then((q) => q.rows);
    expect(row!.status).toBe("running");
    expect(await outboxCount(target.entityId)).toBe(0);
  });

  it("records a person's pause without a hold as unspecified, reviewed in 14 days", async () => {
    const target = await engagement();
    const r = await applyStatusMove(db, {
      target,
      to: "on-hold",
      actor: HUMAN,
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    expect(r.transition.hold).toMatchObject({
      on: "unspecified",
      resumeTo: "running",
    });
    const review = Date.parse(r.transition.hold!.reviewBy!);
    expect(
      Math.round((review - Date.parse(r.transition.hold!.since)) / DAY)
    ).toBe(14);
    expect(r.transition).toMatchObject({
      actorClass: "human",
      appId: null,
      backdated: false,
    });
    expect(r.transition.occurredAt).toBe(r.transition.recordedAt);
  });

  it("records an agent's hold and a backdated occurredAt; the current hold reads it back", async () => {
    const target = await engagement();
    const occurredAt = new Date(Date.now() - 3 * DAY);
    const r = await applyStatusMove(db, {
      target,
      expectedFrom: "running",
      to: "on-hold",
      actor: AGENT,
      hold: { on: "external", ref: "company:acme", until: { date: LATER } },
      occurredAt,
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    expect(r.transition.occurredAt).toBe(occurredAt.toISOString());
    expect(r.transition.backdated).toBe(true);
    expect(Date.parse(r.transition.recordedAt)).toBeGreaterThan(
      occurredAt.getTime()
    );

    const [current] = await listHolds(db, {
      subjects: [subjectOf(target.entityId)],
    });
    expect(current).toMatchObject({
      subjectType: "entity",
      subjectId: target.entityId,
      status: "on-hold",
      transitionId: r.transition.transitionId,
      resumeDue: false,
      reviewDue: false,
      hold: {
        on: "external",
        ref: "company:acme",
        until: { date: LATER },
        resumeTo: "running",
        since: occurredAt.toISOString(),
      },
    });

    // A move between two paused statuses keeps the hold (and where it began).
    const again = await applyStatusMove(db, {
      target: { ...target, current: "on-hold" },
      expectedFrom: "on-hold",
      to: "waiting",
      actor: AGENT,
    });
    expect(again.status).toBe("moved");
    const [carried] = await listHolds(db, {
      subjects: [subjectOf(target.entityId)],
    });
    expect(carried).toMatchObject({
      status: "waiting",
      hold: { on: "external", resumeTo: "running" },
    });

    // The sweep's question: due once the date has come, not before.
    const sweep = await listHolds(db, { resumeDueBy: new Date() });
    expect(sweep.map((x) => x.subjectId)).not.toContain(target.entityId);
    const later = await listHolds(
      db,
      { resumeDueBy: new Date(Date.parse(LATER) + 1000) },
      new Date(Date.parse(LATER) + 1000)
    );
    expect(later.find((x) => x.subjectId === target.entityId)).toMatchObject({
      resumeDue: true,
    });

    // A move out of the pause ends it: no hold is current any more.
    await applyStatusMove(db, {
      target: { ...target, current: "waiting" },
      to: "running",
      actor: HUMAN,
    });
    expect(
      await listHolds(db, { subjects: [subjectOf(target.entityId)] })
    ).toEqual([]);
  });

  it("a status written outside the doors leaves no hold current", async () => {
    const target = await engagement();
    await applyStatusMove(db, { target, to: "on-hold", actor: HUMAN });
    await h.pg.query(`UPDATE entities SET status = 'waiting' WHERE id = $1`, [
      target.entityId,
    ]);
    expect(
      await listHolds(db, { subjects: [subjectOf(target.entityId)] })
    ).toEqual([]);
  });

  it("answers the reactor: the holds waiting on a thing that moved", async () => {
    const awaited = await engagement();
    const waiter = await engagement();
    await applyStatusMove(db, {
      target: waiter,
      to: "on-hold",
      actor: AGENT,
      hold: {
        on: "thing",
        until: { moves: `entity:${awaited.entityId}`, to: "done" },
      },
    });
    const found = await listHolds(db, {
      awaiting: { subjectType: "entity", subjectId: awaited.entityId },
    });
    expect(found.map((x) => x.subjectId)).toEqual([waiter.entityId]);
  });
});

describe("goal pause (TrackRepository.transitionStatus)", () => {
  async function goal() {
    const [p] = await db
      .insert(schema.projects)
      .values({
        userId: "u1",
        name: `p-${randomUUID()}`,
        workspaceId: randomUUID(),
      })
      .returning();
    const [t] = await db
      .insert(schema.projectTracks)
      .values({
        projectId: p.id,
        userId: "u1",
        name: "Ship it",
        status: "active",
      })
      .returning();
    return t.id as string;
  }

  it("refuses an agent's pause without a hold and writes nothing", async () => {
    const id = await goal();
    await expect(
      repo.transitionStatus(
        id,
        { from: "active", to: "paused", actor: AGENT },
        "u1"
      )
    ).rejects.toBeInstanceOf(HoldRefusedError);
    const [row] = await h.pg
      .query<{ status: string }>(
        `SELECT status FROM project_tracks WHERE id = $1`,
        [id]
      )
      .then((q) => q.rows);
    expect(row!.status).toBe("active");
    expect(await outboxCount(id)).toBe(0);
  });

  it("records a check gate's pause as a hold on the check", async () => {
    const id = await goal();
    await repo.transitionStatus(
      id,
      {
        from: "active",
        to: "paused",
        actor: { kind: "system" },
        hold: { on: "thing", ref: "check:review" },
      },
      "u1"
    );
    const [current] = await listHolds(db, {
      subjects: [{ subjectType: "track", subjectId: id }],
    });
    expect(current).toMatchObject({
      status: "paused",
      hold: { on: "thing", ref: "check:review", resumeTo: "active" },
    });
    expect(current!.hold.reviewBy).not.toBeNull();
  });
});

describe("session pause (setSessionStatus)", () => {
  async function session(status: string) {
    const r = await h.pg.query<{ id: string }>(
      `INSERT INTO focus_sessions (id, user_id, goal, status)
       VALUES (gen_random_uuid(), 'u1', 'g', $1) RETURNING id`,
      [status]
    );
    return r.rows[0]!.id;
  }

  it("refuses an agent's pause without a hold and writes nothing", async () => {
    const id = await session("active");
    await expect(
      setSessionStatus(db, {
        sessionId: id,
        from: "active",
        to: "paused",
        actor: AGENT,
      })
    ).rejects.toThrow(HOLD_REQUIRED_MESSAGE);
    const [row] = await h.pg
      .query<{ status: string }>(
        `SELECT status FROM focus_sessions WHERE id = $1`,
        [id]
      )
      .then((q) => q.rows);
    expect(row!.status).toBe("active");
    expect(await outboxCount(id)).toBe(0);
  });

  it("the reaper's stale is held on nobody, and keeps a person's earlier hold", async () => {
    const idle = await session("active");
    const held = await session("active");
    await setSessionStatus(db, {
      sessionId: held,
      from: "active",
      to: "paused",
      actor: HUMAN,
      hold: { on: "person", until: { date: LATER } },
    });
    await setSessionStatus(db, {
      sessionId: idle,
      from: ["active", "paused"],
      to: "stale",
      actor: { kind: "system" },
      defaultHold: { on: "nobody", reason: "idle" },
    });
    await setSessionStatus(db, {
      sessionId: held,
      from: ["active", "paused"],
      to: "stale",
      actor: { kind: "system" },
      defaultHold: { on: "nobody", reason: "idle" },
    });
    const holds = await listHolds(db, {
      subjects: [idle, held].map((subjectId) => ({
        subjectType: "focus_session" as const,
        subjectId,
      })),
    });
    const byId = new Map(holds.map((x) => [x.subjectId, x]));
    expect(byId.get(idle)).toMatchObject({
      status: "stale",
      hold: { on: "nobody", reason: "idle", resumeTo: "active" },
    });
    expect(byId.get(held)).toMatchObject({
      status: "stale",
      hold: { on: "person", until: { date: LATER }, resumeTo: "active" },
    });
  });
});
