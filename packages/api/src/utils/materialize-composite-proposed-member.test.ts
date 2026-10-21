/**
 * Outside a plan, a create the entity door routes to REVIEW fails the graph,
 * named, and the receipt says failed — never applied.
 *
 * MEASURED DEFECT (live, 2026-10-18): the capture auto-apply's inner
 * `entities.create` answered `{ status: "proposed" }` (no id); the materializer
 * kept going with `realId = undefined` and the first writer of that id, the
 * idempotency link's `onConflictDoUpdate({ set: { entityId: undefined } })`,
 * died with drizzle's "No values to set". The receipt then read "Couldn't
 * apply — an internal error occurred", and without the link door the graph
 * would have "applied" with an undefined entity in it.
 *
 * Driven through the real `materializeCompositeGraph` under the real
 * `runMaterializationUnderReceipt` (the receipt writer the auto-apply uses),
 * with the same idempotency door shape the capture door passes.
 */
import { describe, it, expect, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "./materialize-composite.js";
import { runMaterializationUnderReceipt } from "../services/proposals/stamp-materialized.js";

const ops: CompositeProposalOperation[] = [
  {
    op: "create_entity",
    ref: "e0",
    profileSlug: "decision",
    title: "Synap messaging",
    properties: { decisionStatus: "accepted" },
  },
];

function idempotency() {
  return {
    namespace: "u1:key",
    provider: "capture",
    lookup: vi.fn(async () => null),
    // The real door's write of an undefined id is what threw live.
    register: vi.fn(async (entityId: unknown) => {
      if (entityId === undefined) throw new Error("No values to set");
    }),
  };
}

const relationCaller = { create: vi.fn(async () => ({ id: "rel" })) };
const proposedInstead = {
  create: vi.fn(async () => ({
    status: "proposed",
    proposalId: "p-inner",
    entity: null,
  })),
};

describe("a member routed to review fails the graph, named", () => {
  it("rejects naming the proposal, before any id is written", async () => {
    const idem = idempotency();
    await expect(
      materializeCompositeGraph(
        ops,
        proposedInstead as never,
        relationCaller,
        undefined,
        { idempotency: idem }
      )
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("(proposal p-inner)"),
    });
    expect(idem.register).not.toHaveBeenCalled();
  });

  it("the receipt is marked failed with that sentence, not applied", async () => {
    const sets: Array<Record<string, unknown>> = [];
    const database = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return { where: async () => undefined };
        },
      }),
    };
    await expect(
      runMaterializationUnderReceipt(
        { id: "receipt-1", data: { source: "agent" } },
        () =>
          materializeCompositeGraph(
            ops,
            proposedInstead as never,
            relationCaller,
            undefined,
            { idempotency: idempotency() }
          ),
        database as never
      )
    ).rejects.toThrow(/routed to review/);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      status: "approval_failed",
      rejectionReason: expect.stringContaining("routed to review"),
      data: { failure: { errorClass: "conflict" } },
    });
  });
});
