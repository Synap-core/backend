/**
 * The revise core hands an agent's OWN revision of its operations to the
 * re-decision, after the revision is written, and nothing else.
 *
 * THE GAP (structural plan S4, research fbb1eef7 §2): `mergeProposalRevision`
 * wrote the revised payload and never decided it again, so a graph parked for
 * a reason the revision removed waited for a person forever.
 *
 * Rows that rule out a wrong rule:
 *  - the author agent revising `operations` ⇒ re-decided, with the revision
 *    count the row holds AFTER this revision (the claim's compare value);
 *  - the same agent revising only the summary ⇒ not re-decided (nothing it
 *    would decide changed);
 *  - a PERSON revising the same operations ⇒ not re-decided ("Save & Approve"
 *    is a decision; a reviewer's edit is not the agent asking again).
 *
 * Harness: `proposals-service.plan-revision.test.ts` (real core, fake
 * transaction). The re-decision itself is `redecide-graph-revision.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  written: [] as Array<Record<string, unknown>>,
  redecided: [] as Array<{ input: unknown; writtenBefore: number }>,
  /** What the fake re-decision answers. */
  redecision: null as unknown,
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
    computeCanReviewApproval: async () => ({ allowed: true, reason: "owner" }),
  })
);

vi.mock("./redecide-graph-revision.js", () => ({
  redecideOwnGraphRevision: vi.fn(async (input: unknown) => {
    h.redecided.push({ input, writtenBefore: h.written.length });
    return h.redecision;
  }),
}));

import { mergeProposalRevision } from "./proposals-service.js";

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
const AGENT = "agent-1";
const OWNER = "owner-1";

const operations = [
  { op: "create_project", ref: "p1", name: "Acme onboarding" },
  { op: "create_session", ref: "s1", goal: "spec", projectRef: "p1" },
];

beforeEach(() => {
  h.written.length = 0;
  h.redecided.length = 0;
  h.redecision = null;
  h.row = {
    data: { operations, source: "agent", graphSource: "capture" },
    status: "pending",
    workspaceId: null,
    subjectUserId: OWNER,
    createdBy: OWNER,
    agentUserId: AGENT,
    // Two earlier revisions: this one makes it three.
    revisionHistory: [{}, {}],
  };
});

describe("mergeProposalRevision — an agent's own revision is decided again", () => {
  it("the author agent revising its operations is re-decided, after the write, at the new revision count", async () => {
    await mergeProposalRevision({
      proposalId: PROPOSAL,
      actorId: OWNER,
      actingAgentUserId: AGENT,
      patch: {
        kind: "inner",
        fields: {
          operations: [{ ...operations[0], name: "Renamed" }, operations[1]],
        },
      },
    });
    expect(h.written).toHaveLength(1);
    expect(h.redecided).toEqual([
      {
        input: { proposalId: PROPOSAL, actingAgentUserId: AGENT, revisions: 3 },
        writtenBefore: 1,
      },
    ]);
  });

  it("a summary-only revision by the same agent is not re-decided", async () => {
    await mergeProposalRevision({
      proposalId: PROPOSAL,
      actorId: OWNER,
      actingAgentUserId: AGENT,
      summary: "clearer words",
    });
    expect(h.written).toHaveLength(1);
    expect(h.redecided).toEqual([]);
  });

  it("a PERSON revising the same operations is not re-decided", async () => {
    await mergeProposalRevision({
      proposalId: PROPOSAL,
      actorId: OWNER,
      patch: {
        kind: "inner",
        fields: {
          operations: [{ ...operations[0], name: "Renamed" }, operations[1]],
        },
      },
    });
    expect(h.written).toHaveLength(1);
    expect(h.redecided).toEqual([]);
  });

  it("hands the re-decision back to the revise door (it says what happened)", async () => {
    const applied = {
      outcome: "applied",
      proposalId: PROPOSAL,
      materialized: { entityIds: ["ent-1"] },
    };
    h.redecision = applied;
    await expect(
      mergeProposalRevision({
        proposalId: PROPOSAL,
        actorId: OWNER,
        actingAgentUserId: AGENT,
        patch: { kind: "inner", fields: { operations } },
      })
    ).resolves.toEqual(applied);
  });

  it("answers null when nothing was re-decided", async () => {
    await expect(
      mergeProposalRevision({
        proposalId: PROPOSAL,
        actorId: OWNER,
        actingAgentUserId: AGENT,
        summary: "clearer words",
      })
    ).resolves.toBeNull();
  });
});
