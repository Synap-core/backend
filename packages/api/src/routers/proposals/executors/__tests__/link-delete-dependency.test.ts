/**
 * The `link/delete` approval executor for a DEPENDENCY edge (`blocked_by` /
 * `replaces`) — the approval half of an agent removing a blocker from its
 * running session (`synap_update_session` `removeBlockedBySessionIds` →
 * `governedRemoveDependencyLink` files `link/delete`).
 *
 * The defect this pins: `link/delete` has an EXACT executor, so the catch-all's
 * dependency branch never sees a delete — and the exact executor refused every
 * shape but a project `uses` edge. A filed removal could never be approved.
 *
 * Asserted: the replay goes through THE dependency door
 * (`applyApprovedDependencyLink`, action `delete`), floored on the proposal's
 * SUBJECT user (never the approver); a refusal throws with the door's reason
 * and marks nothing approved; the receipt carries the DELETE's own row count.
 * The door itself (its floor against today's rows) has its own suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  apply: vi.fn(),
  proposalStatus: "pending" as string,
  updates: [] as unknown[],
}));

vi.mock(
  "../../../../services/links/dependency-links.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    applyApprovedDependencyLink: (...a: unknown[]) => h.apply(...a),
  })
);
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    db: {
      select: () => ({
        from: () => ({
          where: async () => [{ status: h.proposalStatus }],
        }),
      }),
      update: () => ({
        set: (v: unknown) => ({
          where: async () => {
            h.updates.push(v);
          },
        }),
      }),
    },
  };
});

import { proposalExecRegistry } from "../../execution-registry.js";
import { registerLinkExecutors } from "../link.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const APPROVER = "55555555-5555-4555-8555-555555555555";
const WORK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DROPPED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

registerLinkExecutors();
const exec = proposalExecRegistry.resolve("link/delete")!;
const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
} as never;
const stored = {
  requestId: "r-1",
  targetType: "link",
  changeType: "delete",
  data: {
    title: "session --blocked_by--> session",
    fromType: "session",
    fromId: WORK,
    toType: "session",
    toId: DROPPED,
    linkType: "blocked_by",
  },
};
const run = (subjectUserId: string | null = OWNER) =>
  exec.execute({
    proposal: {
      id: "p-1",
      targetType: "link",
      targetId: WORK,
      proposalType: "delete",
      workspaceId: null,
      sessionId: WORK,
      projectId: null,
      agentUserId: "agent-1",
      subjectUserId,
      sourceMessageId: null,
      data: stored,
    },
    payload: stored as never,
    userId: APPROVER,
    input: { proposalId: "p-1" },
    ctx: {} as never,
    deps,
  } as never);

beforeEach(() => {
  h.apply.mockReset();
  h.proposalStatus = "pending";
  h.updates = [];
});

describe("link/delete approval — a dependency edge", () => {
  it("replays through THE dependency door, floored on the SUBJECT user, and reports the delete's rows", async () => {
    h.apply.mockResolvedValue({ ok: true, rows: 1 });
    const res = await run();
    expect(h.apply).toHaveBeenCalledWith({
      action: "delete",
      data: stored.data,
      ownerUserId: OWNER,
      proposalId: "p-1",
    });
    expect(res).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1, subject: "link" },
    });
    expect(h.updates).toHaveLength(1);
  });

  it("a refusal from the door throws its reason and approves nothing", async () => {
    h.apply.mockResolvedValue({
      ok: false,
      why: "the waiting end must still exist.",
    });
    await expect(run()).rejects.toThrow(/waiting end must still exist/);
    expect(h.updates).toHaveLength(0);
  });

  it("an already-approved proposal is not replayed", async () => {
    h.proposalStatus = "approved";
    expect(await run()).toMatchObject({ success: true, alreadyApproved: true });
    expect(h.apply).not.toHaveBeenCalled();
  });
});
