/**
 * The transition OUTBOX on a real Postgres (PGlite), review D8:
 *  - a move owes its event from the SAME transaction: moved ⇒ exactly one row
 *    carrying the transition and the emit context; conflict ⇒ none; an outbox
 *    that cannot be written rolls the CAS back (the thing does not move);
 *  - claim is a lease: a held row is not claimed twice;
 *  - an incomplete settle keeps progress and backs off; the sweeper lists it
 *    only once the backoff lapses; a complete settle is never claimed again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import {
  applyStatusMove,
  resolveStatusMoveTarget,
} from "../apply-status-move.js";
import {
  claimTransitionOutbox,
  listDueTransitions,
  settleTransitionOutbox,
} from "../transition-outbox.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;
let dealProfile: string;

const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  const [p] = await db
    .insert(schema.profiles)
    .values({ slug: "deal", displayName: "deal", profileKind: "kind" })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "commercialStage",
      valueType: "string",
      profileId: p.id,
      constraints: buildStoredConstraints({
        enumOptions: [
          { key: "draft", category: "open" },
          { key: "negotiating", category: "active" },
          { key: "lost", category: "lost" },
        ],
      }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, {
    profileId: p.id,
    propertySlug: "commercialStage",
  });
  dealProfile = p.id;
}, 120_000);
afterAll(async () => h?.pg.close());

async function deal(status = "draft") {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      profileId: dealProfile,
      type: "deal",
      status,
      properties: { commercialStage: status },
    })
    .returning();
  return e.id as string;
}
async function target(entityId: string) {
  const r = await resolveStatusMoveTarget(db, { entityId });
  if (!r.ok) throw new Error(r.reason);
  return r.target;
}
const outboxFor = (entityId: string) =>
  h.pg
    .query<{
      transition_id: string;
      transition: { entityId: string; to: string };
      emit_context: Record<string, unknown>;
    }>(
      `SELECT transition_id, transition, emit_context FROM lifecycle_transition_outbox WHERE transition->>'entityId' = $1`,
      [entityId]
    )
    .then((r) => r.rows);
const statusOf = async (id: string) =>
  (
    await db
      .select({ status: schema.entities.status })
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
  )[0].status;

describe("a move owes its event in the CAS transaction", () => {
  it("moved ⇒ exactly one outbox row with the transition and the emit context", async () => {
    const id = await deal();
    const r = await applyStatusMove(db, {
      target: await target(id),
      expectedFrom: "draft",
      to: "negotiating",
      actor: AGENT,
      emitContext: { automationContext: { automationRunId: "run-1" } },
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    const rows = await outboxFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].transition_id).toBe(r.transition.transitionId);
    expect(rows[0].transition.to).toBe("negotiating");
    expect(rows[0].emit_context).toEqual({
      automationContext: { automationRunId: "run-1" },
    });
  });

  it("conflict ⇒ no row", async () => {
    const id = await deal("negotiating");
    const t = await target(id);
    await h.pg.query(`UPDATE entities SET status = 'lost' WHERE id = $1`, [id]);
    const r = await applyStatusMove(db, {
      target: t,
      to: "draft",
      actor: AGENT,
    });
    expect(r.status).toBe("conflict");
    expect(await outboxFor(id)).toEqual([]);
  });

  it("an outbox that cannot be written rolls the move back", async () => {
    const id = await deal();
    const t = await target(id);
    await h.pg.exec(
      `ALTER TABLE lifecycle_transition_outbox RENAME TO lifecycle_transition_outbox_off`
    );
    try {
      await expect(
        applyStatusMove(db, { target: t, to: "negotiating", actor: AGENT })
      ).rejects.toThrow();
    } finally {
      await h.pg.exec(
        `ALTER TABLE lifecycle_transition_outbox_off RENAME TO lifecycle_transition_outbox`
      );
    }
    expect(await statusOf(id)).toBe("draft");
  });
});

describe("claim → settle", () => {
  it("leases, keeps progress on failure, backs off, and closes on success", async () => {
    const id = await deal();
    const r = await applyStatusMove(db, {
      target: await target(id),
      to: "negotiating",
      actor: AGENT,
    });
    if (r.status !== "moved") throw new Error(r.status);
    const tid = r.transition.transitionId;

    const first = await claimTransitionOutbox(db, tid);
    expect(first).toMatchObject({ eventId: null, delivered: [], attempts: 1 });
    expect(first?.transition.transitionId).toBe(tid);
    // Held: a second dispatcher gets nothing.
    expect(await claimTransitionOutbox(db, tid)).toBeNull();

    await settleTransitionOutbox(db, tid, {
      eventId: tid,
      delivered: ["transition:search-index"],
      complete: false,
      error: "queue down",
    });
    // Fresh (inside the sweep grace) and backing off: not due yet.
    expect(await listDueTransitions(db)).not.toContain(tid);
    await h.pg.query(
      `UPDATE lifecycle_transition_outbox
          SET created_at = now() - interval '1 hour', claimed_until = now() - interval '1 second'
        WHERE transition_id = $1`,
      [tid]
    );
    expect(await listDueTransitions(db)).toContain(tid);

    const retry = await claimTransitionOutbox(db, tid);
    expect(retry).toMatchObject({
      eventId: tid,
      delivered: ["transition:search-index"],
      attempts: 2,
    });
    await settleTransitionOutbox(db, tid, {
      eventId: tid,
      delivered: ["transition:search-index", "transition:automation"],
      complete: true,
    });
    await h.pg.query(
      `UPDATE lifecycle_transition_outbox SET claimed_until = NULL WHERE transition_id = $1`,
      [tid]
    );
    expect(await claimTransitionOutbox(db, tid)).toBeNull();
    expect(await listDueTransitions(db)).not.toContain(tid);
  });
});
