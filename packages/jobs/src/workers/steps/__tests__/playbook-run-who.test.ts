/**
 * A `playbook_run` step RECORDS WHO did it (runner engine slice 5, 0418): the
 * agent the spine handed the run to, that agent's computer, and the run's
 * session, on the step's own row. A loop step (several children on one row)
 * records nothing; `await` beside an appointment or a proposal fails the step
 * before anything starts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: {
      id: "run-1",
      status: "running",
      runOn: {
        executor: "external-agent",
        agentUserId: "agent-1",
        computerUserId: "mac-1",
        via: "named",
      },
    },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  writes: [] as Array<{
    table: unknown;
    set: Record<string, unknown>;
    where: unknown;
  }>,
}));

vi.mock("@synap/database", () => {
  const automationStepRuns = { id: "automation_step_runs.id" };
  return {
    db: {
      query: { entities: { findFirst: vi.fn(async () => undefined) } },
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => {
            h.writes.push({ table, set, where });
            return Promise.resolve(undefined);
          },
        }),
      }),
    },
    eq: (col: unknown, v: unknown) => ({ col, v }),
    and: vi.fn(),
    isNull: vi.fn(),
    entities: {},
    events: {},
    automationStepRuns,
    proposals: {},
    ProposalStatus: { PENDING: "pending" },
    insertPendingProposal: vi.fn(),
    verifyPermission: vi.fn(),
    countWorkerPendingApprovals: vi.fn(async () => 0),
  };
});
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

import { automationStepRuns } from "@synap/database";
import { executePlaybookRun } from "../playbook-run.js";
import { registerPlaybookRunner } from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const stepWrites = () => h.writes.filter((w) => w.table === automationStepRuns);

beforeEach(() => {
  h.runnerMock.mockClear();
  h.writes.length = 0;
  registerPlaybookRunner(h.runnerMock as never);
});

describe("executePlaybookRun — who did it", () => {
  it("writes the handed agent, its computer and the run's session on the step row", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", handToAgentId: "agent-1" },
      context(),
      "ws-1",
      "user-1",
      undefined,
      null,
      { nodeId: "run", stepRunId: "step-1" }
    );
    expect(stepWrites()).toEqual([
      {
        table: automationStepRuns,
        set: {
          agentUserId: "agent-1",
          computerUserId: "mac-1",
          childSessionId: "sess-run",
        },
        where: { col: automationStepRuns.id, v: "step-1" },
      },
    ]);
  });

  it("a run the pod did records no agent", async () => {
    h.runnerMock.mockResolvedValueOnce({
      run: { id: "run-2", status: "running", runOn: null },
      session: { id: "sess-2", channelId: "chan-2" },
    } as never);
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context(),
      "ws-1",
      "user-1",
      undefined,
      null,
      { nodeId: "run", stepRunId: "step-2" }
    );
    expect(stepWrites().map((w) => w.set)).toEqual([
      { agentUserId: null, computerUserId: null, childSessionId: "sess-2" },
    ]);
  });

  it("a loop step records nothing (several children share its row)", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", handToAgentId: "agent-1" },
      context(),
      "ws-1",
      "user-1",
      undefined,
      null,
      { nodeId: "loop", stepRunId: "step-3" },
      { recordWho: false }
    );
    expect(stepWrites()).toEqual([]);
  });

  it.each(["appointment", "propose"] as const)(
    "await beside mode %s fails the step and starts nothing",
    async (mode) => {
      await expect(
        executePlaybookRun(
          { playbookId: "pb-1", await: true, mode },
          context(),
          "ws-1",
          "user-1",
          { automationId: "auto-1", automationRunId: "run-1" } as never
        )
      ).rejects.toThrow(/await waits for a RUN/);
      expect(h.runnerMock).not.toHaveBeenCalled();
    }
  );
});
