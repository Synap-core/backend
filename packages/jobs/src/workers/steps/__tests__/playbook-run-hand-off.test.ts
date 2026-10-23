/**
 * HAND-OFF — a `playbook_run` node's `handToAgentId` reaches the spine on a
 * RUN, and is refused (never dropped) beside a mode that starts no run.
 *
 * The spine half — the agent resolved through THE route, put on the roster,
 * the playbook's executor not dispatched, the agent's orient listing it — is
 * `api/src/services/playbooks/__tests__/scheduled-run-hand-off.pglite.test.ts`.
 * The two executor call sites forwarding the field are pinned by
 * `workers/__tests__/playbook-run-mode-honoured.tripwire.test.ts` (C: every
 * declared `PlaybookRunNodeDef.data` field).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { runnerMock, schedulerMock } = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  schedulerMock: vi.fn(async () => ({
    session: { id: "sess-appt", channelId: null },
    outcome: "created",
    missedCount: 0,
  })),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: vi.fn(async () => undefined) } },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  verifyPermission: vi.fn(),
  countWorkerPendingApprovals: vi.fn(async () => 0),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import {
  registerPlaybookRunner,
  registerSessionScheduler,
} from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const AGENT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  runnerMock.mockClear();
  schedulerMock.mockClear();
  registerPlaybookRunner(runnerMock as never);
  registerSessionScheduler(schedulerMock as never);
});

describe("executePlaybookRun — handToAgentId", () => {
  it("a run hands the spine the agent", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", handToAgentId: AGENT },
      context(),
      "ws-1",
      "user-1"
    );
    expect(runnerMock).toHaveBeenCalledTimes(1);
    expect(
      (runnerMock.mock.calls[0]![0] as Record<string, unknown>).handToAgentId
    ).toBe(AGENT);
  });

  it("a node without it sends no key (every existing node is unchanged)", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context(),
      "ws-1",
      "user-1"
    );
    expect("handToAgentId" in (runnerMock.mock.calls[0]![0] as object)).toBe(
      false
    );
  });

  it.each(["appointment", "propose"] as const)(
    "beside mode %s it FAILS the step and starts nothing (never a silent drop)",
    async (mode) => {
      await expect(
        executePlaybookRun(
          { playbookId: "pb-1", handToAgentId: AGENT, mode },
          context(),
          "ws-1",
          "user-1",
          { automationId: "auto-1", automationRunId: "run-1" } as never
        )
      ).rejects.toThrow(/handToAgentId hands a RUN to an agent/);
      expect(runnerMock).not.toHaveBeenCalled();
      expect(schedulerMock).not.toHaveBeenCalled();
    }
  );
});
