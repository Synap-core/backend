/**
 * `cell/define` approval materializes at the REVIEWED scope, not the payload's.
 *
 * The executor used to read
 *   `innerData.workspaceId ?? proposal.workspaceId ?? null`
 * so the caller-supplied gate `data` chose the cell's scope — and `null` there
 * means POD-GLOBAL (the definition becomes visible in every workspace),
 * regardless of the workspace the proposal was reviewed under. `view/create`
 * (executors/view.ts) already reads only `proposal.workspaceId`.
 *
 * EXECUTABLE: `defineCell` and the two db calls are mocked, so this test drives
 * the real executor body and fails on the old `??` chain.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const defineCell = vi.fn(async (_args: { workspaceId: string | null }) => ({
  id: "cell-1",
}));
vi.mock("../../../services/cells/define-cell.js", () => ({
  defineCell: (args: { workspaceId: string | null }) => defineCell(args),
}));
vi.mock("../executors/shared.js", () => ({ reportApproved: () => undefined }));

// The executor only does: select(status).from(proposals).where(...)  [no limit]
// and update(proposals).set(...).where(...).
vi.mock("@synap/database", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  proposals: { __table: "proposals" },
  eq: () => ({}),
}));
vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved" },
}));

const { registerCellExecutors } = await import("../executors/cell.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

registerCellExecutors();
const executor = proposalExecRegistry.resolveExact("cell/define");

const run = async (args: {
  proposalWorkspaceId: string | null;
  payloadWorkspaceId?: string | null;
}) => {
  if (!executor) throw new Error("cell/define executor not registered");
  await executor.execute({
    proposal: {
      id: "p1",
      targetType: "cell",
      targetId: "c1",
      proposalType: "define",
      workspaceId: args.proposalWorkspaceId,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data: {
        data: {
          name: "MyCell",
          rendererSource: "export default () => null",
          ...("payloadWorkspaceId" in args
            ? { workspaceId: args.payloadWorkspaceId }
            : {}),
        },
      },
    },
    payload: null,
    userId: "reviewer",
    input: { proposalId: "p1" },
    ctx: {} as never,
    deps: { db: {}, emitProposalReviewed: () => undefined } as never,
  });
  const call = defineCell.mock.calls[0];
  if (!call) throw new Error("defineCell was never called");
  return call[0];
};

beforeEach(() => defineCell.mockClear());

describe("cell/define approval scope", () => {
  // NOTE (bite-check, measured): this first case passes under the OLD `??`
  // chain too — `null ?? proposal.workspaceId` falls through, so a payload
  // `null` could never force pod-global. It is kept as a REGRESSION pin on the
  // fall-through, not as proof of the fix. The two cases below are the ones
  // that go red on the old code, and they are the reachable defect: the
  // payload REDIRECTING the cell to a scope no reviewer approved.
  it("does not let a payload `workspaceId: null` widen the reviewed scope", async () => {
    const call = await run({
      proposalWorkspaceId: "ws-reviewed",
      payloadWorkspaceId: null,
    });
    expect(call.workspaceId).toBe("ws-reviewed");
  });

  it("IGNORES a payload naming a DIFFERENT workspace", async () => {
    const call = await run({
      proposalWorkspaceId: "ws-reviewed",
      payloadWorkspaceId: "ws-somewhere-else",
    });
    expect(call.workspaceId).toBe("ws-reviewed");
  });

  it("still materializes pod-wide when the PROPOSAL itself is pod-wide", async () => {
    const call = await run({
      proposalWorkspaceId: null,
      payloadWorkspaceId: "ws-payload",
    });
    expect(call.workspaceId).toBeNull();
  });
});
