/**
 * ONE TRANSITION SHAPE for goals (status-flow W1) and sessions (W2), on a real
 * Postgres (PGlite):
 *  - a goal's status flip (`TrackRepository.transitionStatus`, its one
 *    compare-and-set) owes `track.transition.completed` in the SAME
 *    transaction: one outbox row, the goal as subject, categories from
 *    `TRACK_STATUS_DECLARATION`, the project's space as the lens;
 *  - a lost compare-and-set owes nothing and emits no receipt;
 *  - an outbox that cannot be written rolls the flip back;
 *  - a row owed before transitions named their subject is claimed as an
 *    entity's;
 *  - `setSessionStatus`, the one session status write: compare-and-set on
 *    `from` (one session or a set-based sweep), the caller's columns in the
 *    same statement and nothing else (`updated_at` untouched unless passed),
 *    one transition per row that changed, rolled back with its outbox.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../schema/index.js";
import { ddlFor } from "./lifecycle-pglite.js";
import { TrackRepository } from "../../../repositories/track-repository.js";
import { claimTransitionOutbox } from "../transition-outbox.js";
import { setSessionStatus, writeSessionPatch } from "../session-status.js";
import { eq } from "drizzle-orm";

let pg: PGlite;
let db: any;
let receipts: unknown[];
let repo: TrackRepository;
const OWNER = "u-owner";
const WORKSPACE = randomUUID();

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.projects,
    schema.projectTracks,
    schema.focusSessions,
    schema.lifecycleTransitionOutbox,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(pg, { schema });
  receipts = [];
  repo = new TrackRepository(db, {
    append: async (e: unknown) => {
      receipts.push(e);
      return {};
    },
  } as never);
}, 120_000);
afterAll(async () => pg?.close());

async function goal(status = "active") {
  const [p] = await db
    .insert(schema.projects)
    .values({
      userId: OWNER,
      name: `p-${randomUUID()}`,
      workspaceId: WORKSPACE,
    })
    .returning();
  const [t] = await db
    .insert(schema.projectTracks)
    .values({ projectId: p.id, userId: OWNER, name: "Ship it", status })
    .returning();
  return { trackId: t.id as string, projectId: p.id as string };
}

const owedFor = (subjectId: string) =>
  pg
    .query<{ transition: Record<string, unknown> }>(
      `SELECT transition FROM lifecycle_transition_outbox WHERE transition->>'subjectId' = $1`,
      [subjectId]
    )
    .then((r) => r.rows.map((row) => row.transition));

describe("a goal's status flip owes its transition", () => {
  it("flipped ⇒ one outbox row in the one transition shape", async () => {
    const { trackId, projectId } = await goal("active");
    const before = receipts.length;
    const row = await repo.transitionStatus(
      trackId,
      { from: "active", to: "paused" },
      OWNER
    );
    expect(row?.status).toBe("paused");
    // The receipt every track write keeps is still emitted.
    expect(receipts.length).toBe(before + 1);
    const owed = await owedFor(trackId);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      subjectType: "track",
      subjectId: trackId,
      property: "status",
      from: "active",
      to: "paused",
      fromCategory: "active",
      category: "paused",
      actorKind: "human",
      userId: OWNER,
      agentUserId: null,
      staleExpected: false,
      workspaceId: WORKSPACE,
      projectId,
      trackId,
    });
  });

  it("names the actor and the proposal it is given", async () => {
    const { trackId } = await goal("paused");
    await repo.transitionStatus(
      trackId,
      {
        from: "paused",
        to: "active",
        actor: { kind: "system", userId: OWNER },
        proposalId: "p-1",
      },
      OWNER
    );
    const [t] = await owedFor(trackId);
    expect(t).toMatchObject({
      actorKind: "system",
      proposalId: "p-1",
      fromCategory: "paused",
      category: "active",
    });
  });

  it("a lost compare-and-set owes nothing and emits no receipt", async () => {
    const { trackId } = await goal("completed");
    const before = receipts.length;
    const row = await repo.transitionStatus(
      trackId,
      { from: "active", to: "paused" },
      OWNER
    );
    expect(row).toBeNull();
    expect(receipts.length).toBe(before);
    expect(await owedFor(trackId)).toEqual([]);
  });

  it("an outbox that cannot be written rolls the flip back", async () => {
    const { trackId } = await goal("active");
    await pg.exec(
      `ALTER TABLE lifecycle_transition_outbox RENAME TO lifecycle_transition_outbox_off`
    );
    try {
      await expect(
        repo.transitionStatus(trackId, { from: "active", to: "paused" }, OWNER)
      ).rejects.toThrow();
    } finally {
      await pg.exec(
        `ALTER TABLE lifecycle_transition_outbox_off RENAME TO lifecycle_transition_outbox`
      );
    }
    const r = await pg.query<{ status: string }>(
      `SELECT status FROM project_tracks WHERE id = $1`,
      [trackId]
    );
    expect(r.rows[0]?.status).toBe("active");
  });
});

describe("a row owed before transitions named their subject", () => {
  it("is claimed as an entity's transition", async () => {
    const transitionId = randomUUID();
    await pg.query(
      `INSERT INTO lifecycle_transition_outbox (transition_id, transition, emit_context)
       VALUES ($1, $2, '{}'::jsonb)`,
      [
        transitionId,
        JSON.stringify({ transitionId, entityId: "e-legacy", to: "won" }),
      ]
    );
    const claimed = await claimTransitionOutbox(db, transitionId);
    expect(claimed?.transition).toMatchObject({
      subjectType: "entity",
      subjectId: "e-legacy",
      entityId: "e-legacy",
    });
  });
});

describe("setSessionStatus — the one session status write", () => {
  const LONG_AGO = "2026-01-01T00:00:00.000Z";
  async function session(status: string, userId = OWNER) {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO focus_sessions (id, user_id, goal, status, workspace_id, updated_at)
       VALUES (gen_random_uuid(), $1, 'g', $2, $3, $4) RETURNING id`,
      [userId, status, WORKSPACE, LONG_AGO]
    );
    return r.rows[0]!.id;
  }
  const row = async (id: string) =>
    (
      await pg.query<{ status: string; updated_at: Date; progress: number }>(
        `SELECT status, updated_at, progress FROM focus_sessions WHERE id = $1`,
        [id]
      )
    ).rows[0]!;

  it("moves from `from`, writes the caller's columns, owes one transition", async () => {
    const id = await session("active");
    const r = await setSessionStatus(db, {
      sessionId: id,
      from: ["active", "paused"],
      to: "stale",
      actor: { kind: "system" },
      reason: "quiet",
      set: { progress: 40 },
    });
    expect(r.rows.map((x) => x.id)).toEqual([id]);
    const after = await row(id);
    expect(after.status).toBe("stale");
    expect(after.progress).toBe(40);
    // Not passed, not touched: the reapers' last-activity signal survives.
    expect(new Date(after.updated_at).toISOString()).toBe(LONG_AGO);
    const owed = await owedFor(id);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      transitionId: r.transitions[0]!.transitionId,
      subjectType: "focus_session",
      subjectId: id,
      property: "status",
      from: "active",
      to: "stale",
      fromCategory: "active",
      // `stale` keeps its value and reads as paused.
      category: "paused",
      actorKind: "system",
      // A system move is attributed to the session's own person.
      userId: OWNER,
      sessionId: id,
      reason: "quiet",
      workspaceId: WORKSPACE,
    });
  });

  it("a session not in `from` is left as it is and owes nothing", async () => {
    const id = await session("closed");
    const r = await setSessionStatus(db, {
      sessionId: id,
      from: "paused",
      to: "active",
      actor: { kind: "human", userId: OWNER },
    });
    expect(r).toEqual({ rows: [], transitions: [] });
    expect((await row(id)).status).toBe("closed");
    expect(await owedFor(id)).toEqual([]);
  });

  it("a set-based sweep moves every matching row and only those", async () => {
    const tag = randomUUID();
    const a = await session("active", tag);
    const b = await session("paused", tag);
    const c = await session("closed", tag);
    const r = await setSessionStatus(db, {
      where: eq(schema.focusSessions.userId, tag),
      from: ["active", "paused"],
      to: "stale",
      actor: { kind: "system" },
    });
    expect(r.rows.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect((await row(c)).status).toBe("closed");
    expect((await owedFor(a))[0]).toMatchObject({
      from: "active",
      userId: tag,
    });
    expect((await owedFor(b))[0]).toMatchObject({
      from: "paused",
      fromCategory: "paused",
    });
    expect(await owedFor(c)).toEqual([]);
  });

  it("a patch whose status is already the session's writes the row and owes nothing", async () => {
    const id = await session("active");
    const rows = await writeSessionPatch(db, {
      sessionId: id,
      set: { status: "active", progress: 10 },
      actor: { kind: "agent", userId: OWNER, agentUserId: "a1" },
    });
    expect(rows).toHaveLength(1);
    expect((await row(id)).progress).toBe(10);
    expect(await owedFor(id)).toEqual([]);
  });

  it("a patch with a new status moves it from whatever it stands at", async () => {
    const id = await session("paused");
    await writeSessionPatch(db, {
      sessionId: id,
      set: { status: "active" },
      actor: { kind: "agent", userId: OWNER, agentUserId: "a1" },
      proposalId: "p-2",
    });
    expect((await row(id)).status).toBe("active");
    expect((await owedFor(id))[0]).toMatchObject({
      from: "paused",
      to: "active",
      actorKind: "agent",
      agentUserId: "a1",
      proposalId: "p-2",
    });
  });

  it("a patch with expectedStatus moves only from that status", async () => {
    const id = await session("paused");
    await writeSessionPatch(db, {
      sessionId: id,
      set: { status: "active" },
      actor: { kind: "agent", userId: OWNER, agentUserId: "a1" },
      expectedStatus: "paused",
    });
    expect((await row(id)).status).toBe("active");
    expect((await owedFor(id))[0]).toMatchObject({
      from: "paused",
      to: "active",
    });
  });

  it("a stale expectedStatus is a conflict: nothing written, nothing owed", async () => {
    const id = await session("active");
    const err = await writeSessionPatch(db, {
      sessionId: id,
      set: { status: "paused", progress: 40 },
      actor: { kind: "human", userId: OWNER },
      expectedStatus: "paused",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "LIFECYCLE_STALE",
      expectedFrom: "paused",
      actual: "active",
    });
    const now = await row(id);
    expect(now.status).toBe("active");
    expect(now.progress).not.toBe(40);
    expect(await owedFor(id)).toEqual([]);
  });

  it("a gone session with expectedStatus writes nothing and throws nothing", async () => {
    const rows = await writeSessionPatch(db, {
      sessionId: randomUUID(),
      set: { status: "active" },
      actor: { kind: "human", userId: OWNER },
      expectedStatus: "paused",
    });
    expect(rows).toEqual([]);
  });

  it("inside a caller's transaction it rolls back with it", async () => {
    const id = await session("active");
    await expect(
      db.transaction(async (tx: any) => {
        await setSessionStatus(tx, {
          sessionId: id,
          from: "active",
          to: "paused",
          actor: { kind: "human", userId: OWNER },
        });
        throw new Error("caller failed");
      })
    ).rejects.toThrow("caller failed");
    expect((await row(id)).status).toBe("active");
    expect(await owedFor(id)).toEqual([]);
  });

  it("an outbox that cannot be written rolls the move back", async () => {
    const id = await session("active");
    await pg.exec(
      `ALTER TABLE lifecycle_transition_outbox RENAME TO lifecycle_transition_outbox_off`
    );
    try {
      await expect(
        setSessionStatus(db, {
          sessionId: id,
          from: "active",
          to: "paused",
          actor: { kind: "human", userId: OWNER },
        })
      ).rejects.toThrow();
    } finally {
      await pg.exec(
        `ALTER TABLE lifecycle_transition_outbox_off RENAME TO lifecycle_transition_outbox`
      );
    }
    expect((await row(id)).status).toBe("active");
  });
});
