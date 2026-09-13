/**
 * Decision E (final backend review, 2026-09-13): anchor staleness is enforced on
 * the SERVER. `mergeProposalRevision({ expectedRevision })` compares it with the
 * row's `revisionHistory.length` read UNDER the row lock, and refuses a stale
 * revise with CONFLICT before any write. Undefined keeps every existing caller's
 * behaviour.
 *
 * Harness mirrors `proposals-service.revise-authority.test.ts`: real core, fake
 * transaction (select … for update → the row; update → counted).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  updates: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: async () => (h.row ? [h.row] : []) }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          h.updates += 1;
        },
      }),
    }),
  };
  return {
    ...actual,
    db: {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    },
  };
});

vi.mock(
  "../../routers/proposals/review-authority.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../routers/proposals/review-authority.js")
    >()),
    computeCanReviewApproval: async () => ({ allowed: true, reason: "owner" }),
  })
);

import { mergeProposalRevision } from "./proposals-service.js";

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

beforeEach(() => {
  h.updates = 0;
  h.row = {
    data: { _summary: "original", targetType: "entity", data: { title: "A" } },
    status: "pending",
    workspaceId: null,
    agentUserId: "agent-1",
    // Revised twice since creation.
    revisionHistory: [{ at: "t1" }, { at: "t2" }],
  };
});

const revise = (expectedRevision?: number) =>
  mergeProposalRevision({
    proposalId: PROPOSAL,
    actorId: "user-1",
    patch: { kind: "inner", fields: { title: "B" } },
    summary: "comment applied",
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });

describe("mergeProposalRevision expectedRevision", () => {
  it("refuses a revise against a stale revision with CONFLICT and writes nothing", async () => {
    await expect(revise(1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.updates).toBe(0);
  });

  it("applies a revise against the current revision", async () => {
    await revise(2);
    expect(h.updates).toBe(1);
  });

  it("is a no-op guard when no expected revision is sent (existing callers)", async () => {
    await revise();
    expect(h.updates).toBe(1);
  });
});
