/**
 * `workspace/join` approval — deleted-workspace pre-flight.
 *
 * `proposals.workspaceId` carries NO foreign key to `workspaces`
 * (`workspaceMembers.workspaceId` does, ON DELETE CASCADE) — so a pending
 * join proposal can outlive the workspace it targets. Before this fix, approve
 * emitted `.validated` and flipped the row APPROVED unconditionally; the
 * membership insert then happened later, async, inside the materializer
 * worker — where a deleted target raised a Postgres FK violation nobody saw.
 * The reviewer's screen said success while no membership was ever granted.
 *
 * This test pins the pre-flight: approving a join whose workspace row is
 * absent must throw, synchronously, on the approve call itself — and must
 * NOT flip the proposal to APPROVED first.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every `db.update(...).set(...)` payload, tagged by table. */
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** Whether the workspace-existence SELECT finds a row. */
let workspaceExists = true;
/** What the proposal-status pre-read returns (unused by this executor, but
 * every sibling table select must resolve through the same stub). */
let proposalStatus: string | undefined = "pending";

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock ON PURPOSE — a total replacement silently kills every other
  // export the module imports (`proposals`, `workspaces`, `eq`,
  // `getWorkspaceMembership`) the moment a new one is added, with typecheck
  // still green. See dev-approval-executor.test.ts for the same trap.
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === actual.workspaces) {
              return workspaceExists ? [{ id: "ws-deleted" }] : [];
            }
            // proposals status pre-read (not reached by this executor, but
            // kept faithful to the shape).
            return proposalStatus === undefined
              ? []
              : [{ status: proposalStatus }];
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push({
              table: table === actual.proposals ? "proposals" : "other",
              values,
            });
          },
        }),
      }),
    },
  };
});

vi.mock("../../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerWorkspaceExecutors } from "../workspace.js";
import { auditLog } from "../../../../utils/audit-log.js";

function args(): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "workspace",
      targetId: "ws-deleted",
      proposalType: "join",
      workspaceId: "ws-deleted",
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data: { role: "editor" },
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  };
}

function executor() {
  const ex = proposalExecRegistry.resolveExact("workspace/join");
  if (!ex) throw new Error("executor not registered: workspace/join");
  return ex;
}

beforeEach(() => {
  updates.length = 0;
  workspaceExists = true;
  proposalStatus = "pending";
  vi.mocked(auditLog).mockClear();
  proposalExecRegistry._reset();
  registerWorkspaceExecutors();
});

describe("workspace/join — deleted-workspace pre-flight", () => {
  it("approves normally when the workspace still exists", async () => {
    const result = await executor().execute(args());
    expect(result.success).toBe(true);
    expect(auditLog).toHaveBeenCalledTimes(1);
    const proposalRow = updates.find((u) => u.table === "proposals");
    expect(proposalRow?.values.status).toBe("approved");
  });

  it("throws and does NOT flip APPROVED when the workspace is gone", async () => {
    workspaceExists = false;
    await expect(executor().execute(args())).rejects.toThrow(
      /no longer exists/
    );
    // Neither the audit event nor the status flip may have happened —
    // the false-success this test exists to prevent.
    expect(auditLog).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === "proposals")).toBeUndefined();
  });
});
