/**
 * An agent already ON a session EXPIRES the pending hand-offs of it to that
 * session (ticket 5de7efaa: proposal 98c943af stayed pending after the person
 * attached the agent directly).
 *
 * Rows are stored in the envelope shape `checkPermissionOrPropose` writes for
 * `gateAgentHandOff` (the request under `data.data`). Each row rules a wrong
 * rule out:
 *  - same session, same agent ⇒ EXPIRED + stamped;
 *  - same session, ANOTHER agent ⇒ stays (rules out "every hand-off of the
 *    session");
 *  - same agent, ANOTHER session ⇒ stays (rules out "every hand-off of the
 *    agent");
 *  - same pair, already rejected ⇒ untouched (rules out "any status");
 *  - same pair, another proposal type (a session update) ⇒ stays;
 *  - the hand-off being approved (named) ⇒ stays (rules out the approval
 *    expiring the proposal it is applying).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import { expirePendingHandOffsOfAttachedAgent } from "./expire-pending-hand-offs.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
}, 120_000);
afterAll(async () => h?.pg.close());

const SESSION = "session-1";
const AGENT = "agent-b";

async function file(
  opts: {
    session?: string;
    agent?: string;
    status?: string;
    type?: string;
  } = {}
): Promise<string> {
  const session = opts.session ?? SESSION;
  const { rows } = await h.pg.query<{ id: string }>(
    `INSERT INTO proposals (workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, subject_user_id, created_by)
     VALUES ('w1', 'focus_session', $1, $2, $3, $4, 'agent-a', 'owner-1', 'owner-1') RETURNING id`,
    [
      session,
      opts.type ?? "assign_agent",
      JSON.stringify({
        targetType: "focus_session",
        targetId: session,
        data: { id: session, addAgentId: opts.agent ?? AGENT },
      }),
      opts.status ?? "pending",
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

describe("expirePendingHandOffsOfAttachedAgent", () => {
  it("expires only the pending hand-offs of that agent to that session", async () => {
    const handOff = await file();
    const otherAgent = await file({ agent: "agent-c" });
    const otherSession = await file({ session: "session-2" });
    const decided = await file({ status: "rejected" });
    const update = await file({ type: "update" });

    const expired = await expirePendingHandOffsOfAttachedAgent(
      { sessionId: SESSION, agentId: AGENT },
      db
    );

    expect(expired).toEqual([handOff]);
    const r = await row(handOff);
    expect(r.status).toBe("expired");
    expect(r.data).toMatchObject({ expiredBy: "agent_attached" });
    expect((await row(otherAgent)).status).toBe("pending");
    expect((await row(otherSession)).status).toBe("pending");
    expect((await row(decided)).status).toBe("rejected");
    expect((await row(update)).status).toBe("pending");
  });

  it("never expires the hand-off being approved, named by id", async () => {
    const approving = await file({ session: "session-3" });
    const twin = await file({ session: "session-3" });
    const expired = await expirePendingHandOffsOfAttachedAgent(
      { sessionId: "session-3", agentId: AGENT, landedByProposalId: approving },
      db
    );
    expect(expired).toEqual([twin]);
    expect((await row(approving)).status).toBe("pending");
    expect((await row(twin)).data).toMatchObject({
      supersededByProposalId: approving,
    });
  });
});
