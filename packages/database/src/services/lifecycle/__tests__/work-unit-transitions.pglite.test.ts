/**
 * ONE TRANSITION SHAPE for goals (status-flow W1), on a real Postgres
 * (PGlite):
 *  - a goal's status flip (`TrackRepository.transitionStatus`, its one
 *    compare-and-set) owes `track.transition.completed` in the SAME
 *    transaction: one outbox row, the goal as subject, categories from
 *    `TRACK_STATUS_DECLARATION`, the project's space as the lens;
 *  - a lost compare-and-set owes nothing and emits no receipt;
 *  - an outbox that cannot be written rolls the flip back;
 *  - a row owed before transitions named their subject is claimed as an
 *    entity's.
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
