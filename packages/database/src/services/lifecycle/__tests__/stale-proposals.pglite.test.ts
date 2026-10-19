/**
 * A person's move expires the pending AGENT transition proposals it made stale
 * (review backend F16). Each row rules a wrong rule out: a human-authored
 * proposal, another facet's proposal, a proposal expecting the status the
 * person just chose, an already-decided one, and an agent's move (which
 * expires nothing).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { expireProposalsStaleAfterMove } from "../stale-proposals.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
}, 120_000);
afterAll(async () => h?.pg.close());

const E = "00000000-0000-4000-8000-0000000000e1";
async function proposal(
  name: string,
  opts: {
    agent?: string | null;
    facetId?: string | null;
    expectedFrom: string;
    status?: string;
    target?: string;
  }
) {
  const [row] = (
    await h.pg.query<{ id: string }>(
      `INSERT INTO proposals (workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_by)
       VALUES ('w1', 'entity', $1, 'transition', $2, $3, $4, $5) RETURNING id`,
      [
        opts.target ?? E,
        JSON.stringify({
          name,
          data: {
            entityId: opts.target ?? E,
            facetId: opts.facetId ?? null,
            expectedFrom: opts.expectedFrom,
            to: "won",
          },
        }),
        opts.status ?? "pending",
        opts.agent === undefined ? "agent-1" : opts.agent,
        "u1",
      ]
    )
  ).rows;
  return row.id;
}
const statusOf = async (id: string) =>
  (
    await h.pg.query<{ status: string; data: Record<string, unknown> }>(
      `SELECT status, data FROM proposals WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("expireProposalsStaleAfterMove", () => {
  it("expires only this lifecycle's pending agent proposals that expect another status", async () => {
    const stale = await proposal("stale", { expectedFrom: "draft" });
    const human = await proposal("human", {
      agent: null,
      expectedFrom: "draft",
    });
    const facet = await proposal("facet", {
      facetId: "00000000-0000-4000-8000-0000000000f1",
      expectedFrom: "draft",
    });
    const sameTo = await proposal("sameTo", { expectedFrom: "negotiating" });
    const decided = await proposal("decided", {
      expectedFrom: "draft",
      status: "rejected",
    });
    const other = await proposal("other", {
      expectedFrom: "draft",
      target: "00000000-0000-4000-8000-0000000000e2",
    });

    const ids = await expireProposalsStaleAfterMove(db, {
      transitionId: "00000000-0000-4000-8000-00000000aaaa",
      entityId: E,
      facetId: null,
      to: "negotiating",
      actorKind: "human",
    });
    expect(ids).toEqual([stale]);
    const s = await statusOf(stale);
    expect(s.status).toBe("expired");
    expect(s.data).toMatchObject({
      expiredBy: "lifecycle_move",
      supersededByTransitionId: "00000000-0000-4000-8000-00000000aaaa",
    });
    for (const id of [human, facet, sameTo, other])
      expect((await statusOf(id)).status).toBe("pending");
    expect((await statusOf(decided)).status).toBe("rejected");
  });

  it("an agent's move expires nothing", async () => {
    const p = await proposal("p", {
      target: "00000000-0000-4000-8000-0000000000e3",
      expectedFrom: "draft",
    });
    const ids = await expireProposalsStaleAfterMove(db, {
      transitionId: "00000000-0000-4000-8000-00000000bbbb",
      entityId: "00000000-0000-4000-8000-0000000000e3",
      facetId: null,
      to: "won",
      actorKind: "agent",
    });
    expect(ids).toEqual([]);
    expect((await statusOf(p)).status).toBe("pending");
  });
});
