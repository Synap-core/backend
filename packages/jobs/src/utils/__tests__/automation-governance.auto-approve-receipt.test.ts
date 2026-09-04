/**
 * AUTO-APPROVE RECEIPT on the automation door — the missing half of the ledger.
 *
 * `checkAutomationWriteOrPropose` returned a bare `{ granted: true }` on the
 * `execute` verdict and filed NOTHING. Because `entity.create` sits in
 * DEFAULT_AUTO_APPROVE, that is the DEFAULT path for automation entity writes —
 * which is why `stepRunId` measured 0% across 2961 proposals on 2026-09-03: the
 * only door that ever set that column was the automation PROPOSE path, and
 * automations almost never propose.
 *
 * THE CARDINALITY IS THE DESIGN. `automation-executor.ts` runs an output step
 * once per loop item with `MAX_LOOP_ITERATIONS = 100`, so a receipt per WRITE
 * would let one loop node emit 100 rows and one nightly automation dominate a
 * table whose whole-pod census is 2961. The receipt is therefore per RUN, and
 * the second test below is the one that pins that decision.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  verifyPermissionMock,
  resolveGovernanceMock,
  insertValuesMock,
  insertPendingProposalMock,
  deriveProjectIdMock,
  probeRowsMock,
} = vi.hoisted(() => ({
  verifyPermissionMock: vi.fn(async () => ({ allowed: true })),
  // The shared ladder is mocked at its own subpath so these tests exercise the
  // RECEIPT, not the policy engine (which has its own suites).
  // Typed to the FULL verdict union, not inferred from the first value: `as const`
  // narrowed the mock's return to `"execute"`, so the PROPOSE case below (the one
  // that proves no receipt is filed) failed to typecheck.
  resolveGovernanceMock: vi.fn(
    async (): Promise<{ decision: "execute" | "propose" | "deny" }> => ({
      decision: "execute",
    })
  ),
  insertValuesMock: vi.fn(),
  insertPendingProposalMock: vi.fn(async () => ({
    proposal: { id: "proposal-1" },
    deduped: false,
  })),
  deriveProjectIdMock: vi.fn(async () => null),
  /** Rows the receipt's own existence probe finds. Empty ⇒ not yet filed. */
  probeRowsMock: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock("@synap/database", () => ({
  db: {
    // The ONLY select this door makes with the ladder mocked out is the
    // receipt's own existence probe.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => probeRowsMock.rows),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: unknown) => insertValuesMock(v)),
    })),
  },
  eq: vi.fn(),
  and: vi.fn((...c: unknown[]) => ({ and: c })),
  users: { id: "users.id" },
  workspaces: { id: "workspaces.id" },
  proposals: { id: "id", targetType: "targetType", targetId: "targetId" },
  verifyPermission: verifyPermissionMock,
  ProposalStatus: { PENDING: "pending", AUTO_APPROVED: "auto_approved" },
  insertPendingProposal: insertPendingProposalMock,
  deriveProposalProjectId: deriveProjectIdMock,
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: resolveGovernanceMock,
}));

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

import {
  checkAutomationWriteOrPropose,
  __resetAutomationAutoApproveReceipts,
} from "../automation-governance.js";

const WRITE = {
  ownerId: "agent-owner",
  workspaceId: "ws-1",
  subjectType: "entity",
  action: "create",
  data: { title: "row" },
  automationRunId: "run-1",
  correlationId: "corr-1",
  sessionId: "sess-1",
  stepRunId: "step-1",
  nodeId: "node-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetAutomationAutoApproveReceipts();
  verifyPermissionMock.mockResolvedValue({ allowed: true });
  resolveGovernanceMock.mockResolvedValue({ decision: "execute" });
  insertPendingProposalMock.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  deriveProjectIdMock.mockResolvedValue(null);
  probeRowsMock.rows = [];
});

describe("automation auto-approve receipt", () => {
  it("files an AUTO_APPROVED row carrying the run's workflow attribution", async () => {
    const result = await checkAutomationWriteOrPropose(WRITE as never);

    expect(result).toEqual({ granted: true });
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      status: "auto_approved",
      targetType: "automation_run",
      targetId: "run-1",
      agentUserId: "agent-owner",
      sessionId: "sess-1",
      stepRunId: "step-1",
      nodeId: "node-1",
      correlationId: "corr-1",
    });
  });

  it("files ONE receipt per RUN, not one per write — the volume decision", async () => {
    // A single loop node can auto-approve up to MAX_LOOP_ITERATIONS = 100 writes.
    for (let i = 0; i < 100; i++) {
      await checkAutomationWriteOrPropose({
        ...WRITE,
        stepRunId: `step-${i}`,
      } as never);
    }

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
  });

  it("anchors the receipt to the FIRST write of the run", async () => {
    await checkAutomationWriteOrPropose(WRITE as never);
    await checkAutomationWriteOrPropose({
      ...WRITE,
      subjectType: "document",
      action: "update",
      stepRunId: "step-99",
    } as never);

    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({
        firstWrite: expect.objectContaining({
          subjectType: "entity",
          writeAction: "create",
          stepRunId: "step-1",
        }),
      }),
    });
  });

  it("a receipt already in the DB is not duplicated across processes", async () => {
    probeRowsMock.rows = [{ id: "existing-receipt" }];

    await checkAutomationWriteOrPropose(WRITE as never);

    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("skips when there is no run id — an undedupable row per write is the failure to avoid", async () => {
    const { automationRunId: _drop, ...noRun } = WRITE;

    const result = await checkAutomationWriteOrPropose(noRun as never);

    expect(result).toEqual({ granted: true });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("a receipt failure NEVER turns a granted write into a denial", async () => {
    insertValuesMock.mockImplementation(() => {
      throw new Error("audit table unavailable");
    });

    const result = await checkAutomationWriteOrPropose(WRITE as never);

    expect(result).toEqual({ granted: true });
  });

  it("does not file a receipt when the verdict is PROPOSE", async () => {
    resolveGovernanceMock.mockResolvedValue({ decision: "propose" });

    await checkAutomationWriteOrPropose(WRITE as never);

    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});
