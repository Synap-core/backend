/**
 * Approving a `retire_into` proposal (TEMPLATE-LIFECYCLE Contract A, pod).
 *
 * The agent's door (`retireIntoGoverned`) files ONE `workspace/update` proposal
 * with `operation: "retire_into"`. On approval the executor must RE-PLAN and
 * run the move as the APPROVER (`applyRetireInto`), mark the row approved, and
 * tell the reviewer when the old space was kept or an item failed to move.
 * Before this branch the request fell to the rename/settings path below it.
 *
 * Driven through the REAL registry entry; the move itself
 * (`services/workspace-retire-into.ts`) is mocked at its module seam — it has
 * its own PGlite suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  applyRetireInto: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: async () => [{ status: "pending" }],
  };
  return {
    ...actual,
    db: {
      select: () => chain,
      update: () => ({
        set: (v: Record<string, unknown>) => {
          h.updates.push(v);
          return { where: async () => undefined };
        },
      }),
    },
  };
});

vi.mock("../../../services/workspace-retire-into.js", () => ({
  applyRetireInto: (...a: unknown[]) => h.applyRetireInto(...a),
}));

import { proposalExecRegistry } from "../execution-registry.js";
import { registerWorkspaceExecutors } from "../executors/workspace.js";

registerWorkspaceExecutors();

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

function run() {
  const exec = proposalExecRegistry.resolveExact("workspace/update")!;
  const deps = {
    reportProposalOutcome: vi.fn(),
    emitProposalReviewed: vi.fn(),
  };
  return exec.execute({
    proposal: {
      id: "p-1",
      workspaceId: SOURCE,
      data: {
        data: { id: SOURCE, operation: "retire_into", summary: "Move 3" },
      },
      sourceMessageId: null,
      agentUserId: "agent-1",
      targetType: "workspace",
      proposalType: "update",
    },
    payload: {},
    userId: "approver-1",
    input: { proposalId: "p-1" },
    deps,
  } as never);
}

beforeEach(() => {
  h.applyRetireInto.mockReset();
  h.updates.length = 0;
});

describe("workspace/update — retire_into approval", () => {
  it("re-plans and runs the move AS THE APPROVER, then approves the row", async () => {
    h.applyRetireInto.mockResolvedValue({
      plan: {},
      result: {
        targetWorkspaceId: TARGET,
        failed: [],
        keptBecause: null,
      },
    });
    const out = await run();
    expect(h.applyRetireInto).toHaveBeenCalledWith({
      workspaceId: SOURCE,
      userId: "approver-1",
    });
    expect(out).toEqual({ success: true, primaryId: TARGET });
    expect(h.updates[0]).toMatchObject({
      status: "approved",
      reviewedBy: "approver-1",
    });
  });

  it("tells the reviewer the old space was kept and which item failed", async () => {
    h.applyRetireInto.mockResolvedValue({
      plan: {},
      result: {
        targetWorkspaceId: TARGET,
        failed: [{ entityId: "e-9", error: "denied" }],
        keptBecause: "1 × signal: no place for signal items.",
      },
    });
    const out = (await run()) as { refusals?: string[] };
    expect(out.refusals).toEqual([
      "The old space was kept: 1 × signal: no place for signal items.",
      "Item e-9 was not moved: denied",
    ]);
  });

  it("a plan that no longer holds (template un-retired) refuses and leaves the row pending", async () => {
    h.applyRetireInto.mockRejectedValue(
      Object.assign(new Error('The "radar" template is not retired.'), {
        code: "PRECONDITION_FAILED",
      })
    );
    await expect(run()).rejects.toThrow(/not retired/);
    expect(h.updates).toEqual([]);
  });
});
