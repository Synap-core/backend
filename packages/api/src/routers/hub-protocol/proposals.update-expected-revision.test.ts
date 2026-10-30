/**
 * Hub `proposals.updateProposal` — the procedure between the REST PATCH edge and
 * the shared revise core. Decision E: it must accept `expectedRevision` and hand
 * it to `mergeProposalRevision` (whose own suite proves the CONFLICT). Without
 * this pin the REST test (mocked caller) and the core test (direct call) both
 * stay green while the value is dropped in the middle.
 *
 * `scopedProcedure` is swapped for the bare `t.procedure`: API-key validation
 * needs a live key row and is covered by its own suites.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  merge: vi.fn(async (): Promise<unknown> => undefined),
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock(
  "../../services/proposals/proposals-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/proposals/proposals-service.js")
    >()),
    mergeProposalRevision: h.merge,
  })
);

import { proposalsRouter } from "./proposals.js";

const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
const caller = () =>
  proposalsRouter.createCaller({
    userId: "user-1",
    agentUserId: "agent-1",
  } as never);

beforeEach(() => h.merge.mockClear());

describe("hub proposals.updateProposal expectedRevision", () => {
  it("hands expectedRevision to the shared revise core", async () => {
    await caller().updateProposal({
      proposalId: PROPOSAL,
      data: { title: "B" },
      summary: "comment applied",
      expectedRevision: 2,
    });
    expect(h.merge).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL, expectedRevision: 2 })
    );
  });

  it("rejects a negative expectedRevision at the input boundary", async () => {
    await expect(
      caller().updateProposal({
        proposalId: PROPOSAL,
        data: {},
        expectedRevision: -1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.merge).not.toHaveBeenCalled();
  });
});

// Door parity with `synap_revise_proposal` (30 Oct live test, item 1): the
// Hub revise door also says what the re-decision of the agent's own graph did.
describe("hub proposals.updateProposal reply", () => {
  it("an applied re-decision answers auto_approved with the ids it created", async () => {
    h.merge.mockResolvedValueOnce({
      outcome: "applied",
      proposalId: PROPOSAL,
      materialized: {
        entityIds: ["ent-1"],
        byOp: { u1: { op: "create_entity", entityId: "ent-1" } },
      },
    });
    const out = await caller().updateProposal({
      proposalId: PROPOSAL,
      data: { operations: [] },
    });
    expect(out).toMatchObject({
      success: true,
      proposalId: PROPOSAL,
      status: "auto_approved",
      materializedIds: { u1: { op: "create_entity", id: "ent-1" } },
    });
  });

  it("nothing re-decided: pending", async () => {
    const out = await caller().updateProposal({
      proposalId: PROPOSAL,
      data: { title: "B" },
    });
    expect(out).toMatchObject({ success: true, status: "pending" });
  });
});
