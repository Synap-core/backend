/**
 * `entity/transition` approval: replays the agent's move with its ORIGINAL
 * belief and governance skipped; a person's move in between makes the
 * approval fail as STALE (CONFLICT) and the proposal is NOT marked approved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  move: vi.fn(),
  updates: [] as unknown[],
}));

vi.mock("../../../../services/lifecycle/move-status.js", () => ({
  moveStatus: h.move,
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ status: "pending" }] }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          h.updates.push(v);
        },
      }),
    }),
  },
  proposals: { id: "id", status: "status" },
  eq: () => true,
}));
vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved" },
}));
vi.mock("../shared.js", () => ({ reportApproved: vi.fn() }));

import { registerEntityTransitionExecutors } from "../entity-transition.js";
import { proposalExecRegistry } from "../../execution-registry.js";

registerEntityTransitionExecutors();
const exec = proposalExecRegistry.resolve("entity/transition", "transition")!;

const args = () =>
  ({
    proposal: {
      targetType: "entity",
      proposalType: "transition",
      workspaceId: "w1",
      agentUserId: "a1",
      subjectUserId: "u1",
      data: {
        data: { entityId: "e1", to: "lost", expectedFrom: "negotiating" },
      },
    },
    userId: "approver",
    input: { proposalId: "p1" },
    deps: { emitProposalReviewed: vi.fn() },
  }) as never;

beforeEach(() => {
  h.move.mockReset();
  h.updates = [];
});

describe("entity/transition executor", () => {
  it("replays the agent's belief with governance skipped, then approves", async () => {
    h.move.mockResolvedValue({ status: "moved", transition: {} });
    const r = await exec.execute(args());
    expect(r).toMatchObject({ success: true, primaryId: "e1" });
    expect(h.move.mock.calls[0][0]).toMatchObject({
      entityId: "e1",
      to: "lost",
      expectedFrom: "negotiating",
      approvedProposalId: "p1",
      actor: { kind: "agent", agentUserId: "a1", userId: "u1" },
    });
    expect(h.updates).toEqual([
      expect.objectContaining({ status: "approved" }),
    ]);
  });

  it("a person moved it meanwhile → CONFLICT, nothing approved", async () => {
    h.move.mockResolvedValue({
      status: "conflict",
      expectedFrom: "negotiating",
      actual: "won",
    });
    await expect(exec.execute(args())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(h.updates).toEqual([]);
  });
});
