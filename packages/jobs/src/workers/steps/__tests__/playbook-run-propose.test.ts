import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * PROPOSE MODE — a `playbook_run` node with `mode: "propose"` files ONE
 * governed `playbook/run` proposal and starts NOTHING.
 *
 *  1. The step: the runner (where the agent kickoff lives) and the scheduler
 *     (the other place a session is born) are never called; the proposal door
 *     receives the rule, the playbook, the resolved params and the subject.
 *  2. The door (`proposeRulePlaybookRun`): a second fire on the same (rule,
 *     subject) while the first proposal waits returns that proposal (deduped)
 *     and inserts nothing; otherwise it inserts the row shape the existing
 *     `playbook/run` approval executor reads (`data.data.playbookId` /
 *     `params` / `subjectId`).
 */

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async () => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  schedulerMock: vi.fn(),
  entityFindFirstMock: vi.fn(async () => ({
    id: "ent-1",
    workspaceId: "ws-1",
  })),
  // select() chain results, consumed in order: [pending lookup, owner lookup]
  selectResults: [] as unknown[][],
  insertPendingProposalMock: vi.fn(async () => ({
    proposal: { id: "prop-new" },
    deduped: false,
  })),
  guardMock: vi.fn(),
}));

function chain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const k of ["from", "where", "limit"]) c[k] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
  return c;
}

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: h.entityFindFirstMock } },
    select: () => chain(h.selectResults.shift() ?? []),
  },
  eq: vi.fn(),
  and: vi.fn(),
  drizzleSql: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: h.insertPendingProposalMock,
  deriveProposalProjectId: vi.fn(),
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({ users: {} }));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: h.guardMock,
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../utils/realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(async () => undefined),
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

const context = (payload: Record<string, unknown> = {}) =>
  ({
    trigger: { payload },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const AUTOMATION = {
  automationRunId: "arun-1",
  automationId: "auto-1",
  chainDepth: 1,
};

beforeEach(() => {
  h.runnerMock.mockClear();
  h.schedulerMock.mockClear();
  h.insertPendingProposalMock.mockClear();
  h.guardMock.mockClear();
  h.selectResults.length = 0;
  registerPlaybookRunner(h.runnerMock as never);
  registerSessionScheduler(h.schedulerMock as never);
});

describe("playbook_run — propose mode files a proposal and starts nothing", () => {
  it("files ONE playbook/run proposal carrying rule, playbook, params and subject", async () => {
    h.selectResults.push([], [{ userType: "human" }]);
    const out = await executePlaybookRun(
      {
        playbookId: "pb-1",
        mode: "propose",
        paramsMapping: { topic: "{{trigger.payload.title}}" },
      },
      context({ subjectId: "ent-1", title: "Acme" }),
      "ws-1",
      "user-1",
      AUTOMATION as never,
      // An agent produced the event: in propose mode nothing launches, so the
      // confused-deputy guard is not consulted (a person decides).
      "agent-9",
      { nodeId: "n-1", stepRunId: "sr-1" }
    );

    expect(h.runnerMock).not.toHaveBeenCalled();
    expect(h.schedulerMock).not.toHaveBeenCalled();
    expect(h.guardMock).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "proposed", proposalId: "prop-new" });

    expect(h.insertPendingProposalMock).toHaveBeenCalledTimes(1);
    const row = (
      h.insertPendingProposalMock.mock.calls as unknown[][]
    )[0][0] as {
      targetType: string;
      proposalType: string;
      targetId: string;
      createdBy: string;
      agentUserId: string | null;
      stepRunId: string;
      nodeId: string;
      data: { automationId: string; data: Record<string, unknown> };
    };
    // The EXISTING approval type — `playbook/run` → playbooks.run → runPlaybook.
    expect(row.targetType).toBe("playbook");
    expect(row.proposalType).toBe("run");
    expect(row.targetId).toBe("pb-1");
    expect(row.createdBy).toBe("user-1");
    // A human-owned rule carries no agent attribution.
    expect(row.agentUserId).toBeNull();
    expect(row.data.automationId).toBe("auto-1");
    expect(row.data.data).toEqual({
      playbookId: "pb-1",
      params: { topic: "Acme" },
      subjectId: "ent-1",
    });
    // Step attribution, so proposals.list({ automationId }) finds it.
    expect(row.stepRunId).toBe("sr-1");
    expect(row.nodeId).toBe("n-1");
  });

  it("a second fire on the same (rule, subject) while one waits → skipped / already_proposed, no insert", async () => {
    h.selectResults.push([{ id: "prop-waiting" }]);
    const out = await executePlaybookRun(
      { playbookId: "pb-1", mode: "propose" },
      context({ subjectId: "ent-1" }),
      "ws-1",
      "user-1",
      AUTOMATION as never
    );
    expect(h.insertPendingProposalMock).not.toHaveBeenCalled();
    expect(h.runnerMock).not.toHaveBeenCalled();
    expect(out).toEqual({
      status: "skipped",
      reason: "already_proposed",
      proposalId: "prop-waiting",
    });
  });

  it("an agent-owned rule proposes AS that agent", async () => {
    h.selectResults.push([], [{ userType: "agent" }]);
    await executePlaybookRun(
      { playbookName: "Qualify a lead", mode: "propose" },
      context({}),
      "ws-1",
      "agent-1",
      AUTOMATION as never
    );
    const row = (
      h.insertPendingProposalMock.mock.calls as unknown[][]
    )[0][0] as {
      agentUserId: string | null;
      data: { data: Record<string, unknown> };
    };
    expect(row.agentUserId).toBe("agent-1");
    // Name-only node: the approval executor resolves it through the ONE door.
    expect(row.data.data.playbookName).toBe("Qualify a lead");
    expect(row.data.data.playbookId).toBeUndefined();
  });

  it("refuses to file an unattributable proposal (no owning automation)", async () => {
    await expect(
      executePlaybookRun(
        { playbookId: "pb-1", mode: "propose" },
        context({}),
        "ws-1",
        "user-1"
      )
    ).rejects.toThrow(/needs the automation that owns it/);
    expect(h.runnerMock).not.toHaveBeenCalled();
    expect(h.insertPendingProposalMock).not.toHaveBeenCalled();
  });

  it("absent mode still RUNS (every pre-existing node)", async () => {
    h.guardMock.mockResolvedValue({ decision: "not-agent" });
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context({}),
      "ws-1",
      "user-1"
    );
    expect(h.runnerMock).toHaveBeenCalledTimes(1);
    expect(h.insertPendingProposalMock).not.toHaveBeenCalled();
  });
});
