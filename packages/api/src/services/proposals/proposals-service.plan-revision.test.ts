/**
 * A revision of a pending composite / PLAN is RE-VALIDATED before it is stored.
 *
 * The gap this closes: `mergeProposalRevision` merged whatever `operations` a
 * reviser sent, so the AI answering "change the plan" could store a plan the
 * approval would refuse (a blocker cycle, a ref to nothing) — the human then
 * approved a proposal that could never apply. Now the SAME preflight a submit
 * runs refuses it, with every problem, and writes nothing.
 *
 * Harness mirrors `proposals-service.expected-revision.test.ts`: real core,
 * fake transaction; plus the pre-lock `db.select` read and the relation-def
 * read the validator performs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  written: [] as Array<Record<string, unknown>>,
  allowed: true,
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
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          h.written.push(values);
        },
      }),
    }),
  };
  return {
    ...actual,
    db: {
      // The pre-lock read `validateRevisedOperations` performs.
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.row ? [h.row] : []) }),
        }),
      }),
      query: { relationDefs: { findMany: async () => [] } },
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
    computeCanReviewApproval: async () =>
      h.allowed
        ? { allowed: true, reason: "owner" }
        : { allowed: false, reason: "no" },
  })
);

import { mergeProposalRevision } from "./proposals-service.js";

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

const pendingPlan = {
  operations: [
    { op: "create_project", ref: "p1", name: "Acme onboarding" },
    { op: "create_session", ref: "s1", goal: "spec", projectRef: "p1" },
  ],
  source: "agent",
};

beforeEach(() => {
  h.written.length = 0;
  h.allowed = true;
  h.row = {
    data: pendingPlan,
    status: "pending",
    workspaceId: null,
    subjectUserId: "owner-1",
    createdBy: "owner-1",
    agentUserId: "agent-1",
    revisionHistory: [],
  };
});

const revise = (operations: unknown[]) =>
  mergeProposalRevision({
    proposalId: PROPOSAL,
    actorId: "owner-1",
    patch: { kind: "inner", fields: { operations } },
  });

describe("mergeProposalRevision — plan re-validation", () => {
  it("REFUSES an invalid revised plan with every problem, and writes nothing", async () => {
    const err = await revise([
      { op: "create_session", ref: "a", goal: "a", blockedByRefs: ["b"] },
      { op: "create_session", ref: "b", goal: "b", blockedByRefs: ["a"] },
      { op: "create_session", ref: "c", goal: "c", projectRef: "ghost" },
    ]).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect(String(err.message)).toMatch(/blocked_by cycle/);
    expect(String(err.message)).toMatch(/projectRef "ghost" names no project/);
    expect(h.written).toHaveLength(0);
  });

  it("stores a VALID revised plan — with the pod's evidence verdict stamped, never the caller's", async () => {
    await revise([
      {
        op: "create_project",
        ref: "p1",
        name: "Renamed",
        // A forged verdict must not survive.
        evidence: { counted: 99, minimum: 5, belowAgentFloor: false },
      },
      { op: "create_session", ref: "s1", goal: "spec", projectRef: "p1" },
    ]);
    expect(h.written).toHaveLength(1);
    const stored = (
      h.written[0].data as { operations: Array<Record<string, unknown>> }
    ).operations;
    expect(stored[0]).toEqual(
      expect.objectContaining({
        name: "Renamed",
        evidence: { counted: 0, minimum: 5, belowAgentFloor: true },
      })
    );
  });

  it("an UNAUTHORIZED reviser still reads NOT_FOUND — the validation is no shape oracle", async () => {
    h.allowed = false;
    const err = await revise([
      { op: "create_session", ref: "a", goal: "a", parentRef: "a" },
    ]).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(h.written).toHaveLength(0);
  });
});
