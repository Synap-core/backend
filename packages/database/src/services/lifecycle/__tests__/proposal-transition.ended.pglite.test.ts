/**
 * The status door stamps WHY a proposal ended (`data.ended`, plan 8032a127 D6)
 * on every move to `withdrawn` or `expired`, on a real Postgres (PGlite):
 *  - the caller's reason, with who (`by`, from the actor) and when;
 *  - merged over the caller's own `data` in each shape a caller writes (a SQL
 *    merge, a whole object, none), never replacing it;
 *  - a caller that names no reason gets its status's plain one;
 *  - no other move carries a stamp.
 * Read back through the one read door (`proposalEnded`), so the writer and the
 * reader are tested as one seam.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { PgTable } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { proposalEnded } from "@synap-core/types/proposals/ended";
import * as schema from "../../../schema/index.js";
import { ddlFor } from "./lifecycle-pglite.js";
import {
  endedByNoPersonSet,
  transitionProposal,
} from "../../../utils/proposal-transition.js";

let pg: PGlite;
let db: any;
const REVIEWER = "u-reviewer";

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [schema.proposals, schema.lifecycleTransitionOutbox]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(pg, { schema });
}, 120_000);
afterAll(async () => pg?.close());

async function proposal(status: string, data: unknown = { keep: 1 }) {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO proposals (target_type, target_id, proposal_type, data, status, workspace_id, proposed_by_user_id)
     VALUES ('entity', $1, 'update', $2::jsonb, $3, $4, 'u-owner') RETURNING id`,
    [randomUUID(), JSON.stringify(data), status, randomUUID()]
  );
  return r.rows[0]!.id;
}

async function rowOf(id: string) {
  const r = await pg.query<{
    status: string;
    data: Record<string, unknown>;
    reviewed_by: string | null;
  }>(`SELECT status, data, reviewed_by FROM proposals WHERE id = $1`, [id]);
  const row = r.rows[0]!;
  return { status: row.status, data: row.data, reviewedBy: row.reviewed_by };
}

describe("the status door stamps how a proposal ended", () => {
  it("a supersede: the reason and the newer proposal, over the caller's SQL merge", async () => {
    const id = await proposal("pending");
    const before = Date.now();
    await transitionProposal(db, {
      to: "withdrawn",
      ended: { reason: "superseded", supersededBy: "p-new" },
      set: {
        data: sql`COALESCE(${schema.proposals.data}, '{}'::jsonb) || jsonb_build_object('supersededBy', 'p-new')`,
      },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.status).toBe("withdrawn");
    expect(row.data.keep).toBe(1);
    expect(row.data.supersededBy).toBe("p-new");
    const ended = row.data.ended as Record<string, unknown>;
    expect(ended).toMatchObject({
      reason: "superseded",
      by: "system",
      supersededBy: "p-new",
    });
    expect(Date.parse(String(ended.at))).toBeGreaterThanOrEqual(before - 1000);
    expect(proposalEnded(row)).toMatchObject({
      reason: "superseded",
      supersededBy: "p-new",
    });
  });

  it("a person's withdrawal: `by` is the person, the words are theirs", async () => {
    const id = await proposal("approval_failed");
    await transitionProposal(db, {
      to: "withdrawn",
      ended: { reason: "author", withdrawReason: "Not needed any more" },
      set: { reviewedBy: REVIEWER },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.data.keep).toBe(1);
    expect(proposalEnded(row)).toMatchObject({
      reason: "author",
      by: "person",
      withdrawReason: "Not needed any more",
    });
  });

  it("a sweep with no reason named: an expiry is its moment passing", async () => {
    const id = await proposal("approval_failed");
    await transitionProposal(db, {
      to: "expired",
      set: { ...endedByNoPersonSet(), updatedAt: new Date() },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.reviewedBy).toBeNull();
    expect(row.data.keep).toBe(1);
    expect(row.data.ended).toMatchObject({ reason: "lapsed", by: "system" });
  });

  it("a caller that writes a whole object keeps it, with the stamp on top", async () => {
    const id = await proposal("pending", null);
    await transitionProposal(db, {
      to: "expired",
      ended: { reason: "session_ended" },
      set: { data: { whole: true } },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.data.whole).toBe(true);
    expect(row.data.ended).toMatchObject({ reason: "session_ended" });
  });

  it("a caller that writes null data still gets an object with the stamp", async () => {
    const id = await proposal("pending");
    await transitionProposal(db, {
      to: "withdrawn",
      set: { data: null },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.data).toMatchObject({ ended: { reason: "author" } });
  });

  it("no other move carries a stamp, even with a reason passed", async () => {
    const id = await proposal("pending");
    await transitionProposal(db, {
      to: "approved",
      ended: { reason: "lapsed" },
      set: { reviewedBy: REVIEWER },
      where: eq(schema.proposals.id, id),
    });
    const row = await rowOf(id);
    expect(row.status).toBe("approved");
    expect(row.data).toEqual({ keep: 1 });
  });
});
