/**
 * A landed record EXPIRES the agent's other pending copies of the SAME record
 * (live 2026-10-18/19: five copies of one decision create, one approved, four
 * left pending against the agent's cap).
 *
 * Rows are stored in the request-envelope shape `checkPermissionOrPropose`
 * writes (the record under `data.data`, its minted id inside). Each row rules a
 * wrong rule out:
 *  - same record, other minted id, agent, same owner ⇒ EXPIRED + stamped;
 *  - same title, different content ⇒ stays (rules out "match on name": its
 *    reviewer keeps the identity verbs);
 *  - same record filed by a PERSON ⇒ stays (rules out "every copy");
 *  - same record, another owner ⇒ stays (rules out a pod-wide sweep);
 *  - the landing copy itself (same minted id) ⇒ stays (rules out the approval
 *    replay expiring the proposal it is approving);
 *  - same record, already rejected ⇒ untouched (rules out "any status");
 *  - same title + content, another kind ⇒ stays.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import { expirePendingCreatesOfLandedRecord } from "./expire-pending-creates.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
}, 120_000);
afterAll(async () => h?.pg.close());

const OWNER = "owner-1";
const AGENT = "agent-1";
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  profileSlug: "decision",
  title: "Synap messaging: the data layer",
  properties: { summary: "Lead with usefulness.", decisionStatus: "accepted" },
  global: false,
  resolvedWorkspaceId: null,
  ...over,
});

async function file(
  rec: Record<string, unknown>,
  opts: { agent?: string | null; owner?: string; status?: string } = {}
): Promise<string> {
  const { rows } = await h.pg.query<{ id: string }>(
    `INSERT INTO proposals (workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, subject_user_id, created_by)
     VALUES ('w1', 'entity', $1, 'create', $2, $3, $4, $5, $5) RETURNING id`,
    [
      rec.id,
      JSON.stringify({
        requestId: `req-${rec.id}`,
        source: "agent",
        targetType: "entity",
        targetId: rec.id,
        changeType: "create",
        data: rec,
        summary: "Create Decision",
        correlationId: `corr-${rec.id}`,
      }),
      opts.status ?? "pending",
      opts.agent === undefined ? AGENT : opts.agent,
      opts.owner ?? OWNER,
    ]
  );
  return rows[0]!.id;
}
const row = async (id: string) =>
  (
    await h.pg.query<{ status: string; data: Record<string, unknown> }>(
      `SELECT status, data FROM proposals WHERE id = $1`,
      [id]
    )
  ).rows[0]!;

describe("expirePendingCreatesOfLandedRecord", () => {
  it("expires only the agent's pending copies of the same record", async () => {
    const landing = await file(record("minted-landing"));
    const copy = await file(record("minted-copy"));
    const otherContent = await file(
      record("minted-other", {
        properties: {
          summary: "Lead with ambition.",
          decisionStatus: "accepted",
        },
      })
    );
    const human = await file(record("minted-human"), { agent: null });
    const otherOwner = await file(record("minted-owner2"), {
      owner: "owner-2",
    });
    const decided = await file(record("minted-rejected"), {
      status: "rejected",
    });
    const otherKind = await file(
      record("minted-note", { profileSlug: "note" })
    );

    const expired = await expirePendingCreatesOfLandedRecord(
      {
        record: record("minted-landing"),
        entityId: "entity-landed",
        ownerUserId: OWNER,
        landedByProposalId: null,
      },
      db
    );

    expect(expired).toEqual([copy]);
    const c = await row(copy);
    expect(c.status).toBe("expired");
    expect(c.data).toMatchObject({
      expiredBy: "record_landed",
      supersededByEntityId: "entity-landed",
    });
    // The record itself is kept: approving it later is still traceable.
    expect((c.data.data as { title: string }).title).toBe(
      "Synap messaging: the data layer"
    );
    expect((await row(landing)).status).toBe("pending");
    expect((await row(otherContent)).status).toBe("pending");
    expect((await row(human)).status).toBe("pending");
    expect((await row(otherOwner)).status).toBe("pending");
    expect((await row(decided)).status).toBe("rejected");
    expect((await row(otherKind)).status).toBe("pending");
  });

  it("never expires the proposal that landed it, named by id", async () => {
    const approved = await file(record("minted-a2", { title: "Second" }));
    const sibling = await file(record("minted-b2", { title: "Second" }));
    const expired = await expirePendingCreatesOfLandedRecord(
      {
        // The replay input carries a different minted id than the stored copy.
        record: record("replay-id", { title: "Second" }),
        entityId: "entity-2",
        ownerUserId: OWNER,
        landedByProposalId: approved,
      },
      db
    );
    expect(expired).toEqual([sibling]);
    expect((await row(approved)).status).toBe("pending");
    expect((await row(sibling)).data).toMatchObject({
      supersededByProposalId: approved,
    });
  });
});
