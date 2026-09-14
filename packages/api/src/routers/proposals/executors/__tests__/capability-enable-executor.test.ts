/**
 * Approving a `capability.enable` request enables EVERY listed skill, through
 * the existing `skills.setApproved` door (which carries the owner / pod-admin
 * authority check) — and nothing else.
 *
 * The request is filed per PACK (`proposeCapabilityEnable`), so an executor
 * that only read the legacy single `skillId` would enable one verb of the pack
 * and report success: the "approval that did less than it said" shape.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const setApproved = vi.fn(async () => ({ skill: {} }));
const toolSetApproved = vi.fn(async () => ({ tool: {} }));
const proposalUpdates: Array<Record<string, unknown>> = [];
let proposalStatus = "pending";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => [{ status: proposalStatus }] }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            proposalUpdates.push(values);
          },
        }),
      }),
    },
  };
});

vi.mock("../../../skills.js", () => ({
  skillsRouter: { createCaller: () => ({ setApproved }) },
}));

vi.mock("../../../tools.js", () => ({
  toolsRouter: { createCaller: () => ({ setApproved: toolSetApproved }) },
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerCapabilityExecutors } from "../capability.js";

function args(data: Record<string, unknown>): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "capability",
      targetId: "cap-research",
      proposalType: "capability.enable",
      workspaceId: "ws-1",
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data,
    },
    payload: data,
    userId: "owner-1",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  } as unknown as ProposalExecutorArgs;
}

async function approve(data: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("capability.enable");
  expect(
    executor,
    "capability.enable executor is not registered"
  ).toBeDefined();
  return executor!.execute(args(data));
}

describe("capability.enable executor", () => {
  beforeEach(() => {
    registerCapabilityExecutors();
    setApproved.mockClear();
    proposalUpdates.length = 0;
    proposalStatus = "pending";
  });

  it("enables every skill of the pack via setApproved, then marks the proposal approved", async () => {
    const out = await approve({
      containerId: "cap-research",
      skillIds: ["skill-a", "skill-b"],
      skillId: "skill-a",
    });
    expect(out).toMatchObject({ success: true });
    expect(setApproved.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { id: "skill-a", approved: true },
      { id: "skill-b", approved: true },
    ]);
    expect(proposalUpdates).toHaveLength(1);
    expect(proposalUpdates[0].status).toBe("approved");
  });

  it("enables the pack's TOOLS through tools.setApproved", async () => {
    await approve({ skillIds: [], toolIds: ["tool-a", "tool-b"] });
    expect(setApproved).not.toHaveBeenCalled();
    expect(toolSetApproved.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { id: "tool-a", approved: true },
      { id: "tool-b", approved: true },
    ]);
    expect(proposalUpdates[0].status).toBe("approved");
  });

  it("still accepts the legacy single skillId", async () => {
    await approve({ skillId: "skill-a" });
    expect(setApproved).toHaveBeenCalledTimes(1);
    expect(setApproved).toHaveBeenCalledWith({ id: "skill-a", approved: true });
  });

  it("an already-approved proposal enables nothing again", async () => {
    proposalStatus = "approved";
    const out = await approve({ skillIds: ["skill-a"] });
    expect(out).toMatchObject({ alreadyApproved: true });
    expect(setApproved).not.toHaveBeenCalled();
  });
});
