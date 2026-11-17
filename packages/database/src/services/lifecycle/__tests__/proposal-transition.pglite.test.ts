/**
 * `transitionProposal`, THE proposal status door, OWES each move's transition,
 * on a real Postgres (PGlite):
 *  - a move owes ONE `proposal` transition in the one shape, in the same
 *    transaction as the write: D9 categories, the reviewer as the actor, the
 *    proposal's own id, type and target;
 *  - a row the transition table refuses, or a self-move, owes nothing;
 *  - the builder's contract stands: `await` it, or `.returning({ … })`;
 *  - ONE statement: inside a caller's transaction the caller's rollback takes
 *    the move AND the owed transition;
 *  - a `document/*` patch addresses its section (document + op section ids);
 *  - a session that ends expires its pending stage gate and owes that
 *    proposal's transition inside `setSessionStatus`'s own transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "../../../schema/index.js";
import { ddlFor } from "./lifecycle-pglite.js";
import { transitionProposal } from "../../../utils/proposal-transition.js";
import { setSessionStatus } from "../session-status.js";

let pg: PGlite;
let db: any;
const OWNER = "u-owner";
const REVIEWER = "u-reviewer";
const WORKSPACE = randomUUID();

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.focusSessions,
    schema.proposals,
    schema.lifecycleTransitionOutbox,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(pg, { schema });
}, 120_000);
afterAll(async () => pg?.close());

async function proposal(
  status = "pending",
  over: Partial<{
    targetType: string;
    targetId: string;
    proposalType: string;
    data: unknown;
    sessionId: string | null;
  }> = {}
) {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO proposals (target_type, target_id, proposal_type, data, status, workspace_id, proposed_by_user_id, session_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid) RETURNING id`,
    [
      over.targetType ?? "entity",
      over.targetId ?? randomUUID(),
      over.proposalType ?? "update",
      JSON.stringify(over.data ?? {}),
      status,
      WORKSPACE,
      OWNER,
      over.sessionId ?? null,
    ]
  );
  return r.rows[0]!.id;
}

const owedFor = (subjectId: string) =>
  pg
    .query<{ transition: Record<string, unknown> }>(
      `SELECT transition FROM lifecycle_transition_outbox WHERE transition->>'subjectId' = $1`,
      [subjectId]
    )
    .then((r) => r.rows.map((row) => row.transition));

const statusOf = async (id: string) =>
  (
    await pg.query<{ status: string }>(
      `SELECT status FROM proposals WHERE id = $1`,
      [id]
    )
  ).rows[0]?.status;

describe("transitionProposal owes the move's transition", () => {
  it("an approval owes ONE transition in the one shape, the reviewer its actor", async () => {
    const id = await proposal("pending");
    const rows = await transitionProposal(db, {
      to: "approved",
      set: { reviewedBy: REVIEWER },
      where: eq(schema.proposals.id, id),
    }).returning();
    expect(rows.map((r) => r.status)).toEqual(["approved"]);
    const owed = await owedFor(id);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      subjectType: "proposal",
      subjectId: id,
      proposalId: id,
      property: "status",
      from: "pending",
      to: "approved",
      fromCategory: "open",
      category: "done",
      actorKind: "human",
      userId: REVIEWER,
      workspaceId: WORKSPACE,
      proposalType: "update",
      targetType: "entity",
      section: null,
    });
  });

  it("a move a rule caused carries its cause; one nobody caused carries none", async () => {
    const id = await proposal("pending");
    await transitionProposal(db, {
      to: "expired",
      where: eq(schema.proposals.id, id),
      cause: {
        reactionId: "rule-1",
        transitionId: "t-src",
        chainId: "t-src",
        depth: 1,
      },
    });
    const [t] = await owedFor(id);
    expect(t).toMatchObject({
      to: "expired",
      cause: {
        reactionId: "rule-1",
        transitionId: "t-src",
        chainId: "t-src",
        depth: 1,
      },
    });
    const plain = await proposal("pending");
    await transitionProposal(db, {
      to: "expired",
      where: eq(schema.proposals.id, plain),
    });
    expect((await owedFor(plain))[0]).not.toHaveProperty("cause");
  });

  it("a move nobody attributes is the system's, owned by who filed it", async () => {
    const id = await proposal("pending");
    await transitionProposal(db, {
      to: "expired",
      where: eq(schema.proposals.id, id),
    });
    expect((await owedFor(id))[0]).toMatchObject({
      actorKind: "system",
      userId: OWNER,
      to: "expired",
      category: "lost",
    });
  });

  it("approval_failed reads open (D9) and carries its sentence", async () => {
    const id = await proposal("pending");
    await transitionProposal(db, {
      to: "approval_failed",
      set: { rejectionReason: "It threw." },
      where: eq(schema.proposals.id, id),
    });
    expect((await owedFor(id))[0]).toMatchObject({
      category: "open",
      reason: "It threw.",
    });
  });

  it("a row the table refuses moves nothing and owes nothing", async () => {
    const id = await proposal("withdrawn");
    const rows = await transitionProposal(db, {
      to: "approved",
      where: eq(schema.proposals.id, id),
    }).returning({ id: schema.proposals.id });
    expect(rows).toEqual([]);
    expect(await statusOf(id)).toBe("withdrawn");
    expect(await owedFor(id)).toEqual([]);
  });

  it("a self-move (a re-stamp) is written and owes nothing", async () => {
    const id = await proposal("approved");
    const rows = await transitionProposal(db, {
      to: "approved",
      set: { reviewedBy: REVIEWER },
      where: eq(schema.proposals.id, id),
    }).returning({ id: schema.proposals.id, data: schema.proposals.data });
    expect(rows).toEqual([{ id, data: {} }]);
    expect(await owedFor(id)).toEqual([]);
  });

  it("inside a caller's transaction, the caller's rollback takes the move and the debt", async () => {
    const id = await proposal("pending");
    await expect(
      db.transaction(async (tx: any) => {
        await transitionProposal(tx, {
          to: "rejected",
          where: eq(schema.proposals.id, id),
        });
        throw new Error("the caller failed after");
      })
    ).rejects.toThrow("the caller failed after");
    expect(await statusOf(id)).toBe("pending");
    expect(await owedFor(id)).toEqual([]);
  });

  it("a document patch addresses its section", async () => {
    const doc = randomUUID();
    const id = await proposal("pending", {
      targetType: "document",
      targetId: doc,
      proposalType: "section_update",
      data: {
        ops: [
          { op: "replace_section", sectionId: "s-intro" },
          { op: "append", sectionId: "s-intro" },
          { op: "insert_embed", sectionId: "s-2" },
        ],
      },
    });
    await transitionProposal(db, {
      to: "approved",
      where: eq(schema.proposals.id, id),
    });
    const [t] = await owedFor(id);
    const section = t!.section as { documentId: string; sectionIds: string[] };
    expect(section.documentId).toBe(doc);
    expect([...section.sectionIds].sort()).toEqual(["s-2", "s-intro"]);
  });

  it("a session that ends owes its expired stage gate's transition in its own transaction", async () => {
    const s = await pg.query<{ id: string }>(
      `INSERT INTO focus_sessions (id, user_id, goal, status, workspace_id)
       VALUES (gen_random_uuid(), $1, 'g', 'paused', $2) RETURNING id`,
      [OWNER, WORKSPACE]
    );
    const sessionId = s.rows[0]!.id;
    const gate = await proposal("pending", {
      targetType: "focus_session",
      targetId: sessionId,
      proposalType: "playbook.stage_gate",
      sessionId,
    });
    await setSessionStatus(db, {
      sessionId,
      from: ["paused"],
      to: "cancelled",
      actor: { kind: "system" },
    });
    expect(await statusOf(gate)).toBe("expired");
    expect(await owedFor(gate)).toHaveLength(1);
    expect((await owedFor(gate))[0]).toMatchObject({
      subjectType: "proposal",
      from: "pending",
      to: "expired",
      sessionId,
    });
  });
});
