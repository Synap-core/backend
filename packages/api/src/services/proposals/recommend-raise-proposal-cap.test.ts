import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the RAISE-PROPOSAL-CAP recommender — the pending_proposal_cap
 * twin of recommend-raise-ceiling. Each `it` pins one qualify/dedupe rule.
 *
 * DB-free: `db.select(...)` is a per-table FIFO queue (mirror of the raise-ceiling
 * test); `countPendingAgentProposals` / `agentProposalCap` are mocked so the
 * blocked-vs-under-cap math is deterministic. With cap=10: blocked iff
 * pending >= 10, proposedLimit = ceil(10 * 1.5) = 15.
 */

const {
  queues,
  mockInsertPendingProposal,
  mockNotifyPodWideProposal,
  mockEmitSideEffects,
  mockCountPending,
  mockAgentProposalCap,
} = vi.hoisted(() => ({
  queues: {
    users: [] as unknown[][],
    proposals: [] as unknown[][],
    governanceCeilings: [] as unknown[][],
  },
  mockInsertPendingProposal: vi.fn(),
  mockNotifyPodWideProposal: vi.fn().mockResolvedValue(undefined),
  mockEmitSideEffects: vi.fn().mockResolvedValue(undefined),
  mockCountPending: vi.fn(),
  mockAgentProposalCap: vi.fn(),
}));

vi.mock("@synap/database", () => {
  const TABLES = {
    users: { __key: "users" as const },
    proposals: { __key: "proposals" as const },
    governanceCeilings: { __key: "governanceCeilings" as const },
  };

  function shift(key: string): unknown[] {
    const q = queues[key as keyof typeof queues];
    if (!q || q.length === 0) {
      throw new Error(
        `recommend-raise-proposal-cap.test mock: no queued response for table "${key}"`
      );
    }
    return q.shift()!;
  }

  const select = vi.fn(() => ({
    from: (table: { __key: string }) => {
      const builder: Record<string, unknown> = {
        where: () => builder,
        orderBy: () => builder,
        limit: () => Promise.resolve(shift(table.__key)),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(shift(table.__key)).then(res, rej),
      };
      return builder;
    },
  }));

  return {
    db: { select },
    and: vi.fn((...c: unknown[]) => ({ and: c })),
    or: vi.fn((...c: unknown[]) => ({ or: c })),
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
    users: TABLES.users,
    proposals: TABLES.proposals,
    governanceCeilings: TABLES.governanceCeilings,
    insertPendingProposal: mockInsertPendingProposal,
    ProposalStatus: { PENDING: "pending" },
  };
});

vi.mock("../../utils/permission-check.js", () => ({
  countPendingAgentProposals: mockCountPending,
  agentProposalCap: mockAgentProposalCap,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/events", () => ({ emitSideEffects: mockEmitSideEffects }));

vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: mockNotifyPodWideProposal,
}));

import { recommendRaiseProposalCapForAllAgents } from "./recommend-raise-proposal-cap.js";

function agentRow(id: string, createdByUserId = "human-1") {
  return { id, createdByUserId };
}

beforeEach(() => {
  vi.clearAllMocks();
  queues.users = [];
  queues.proposals = [];
  queues.governanceCeilings = [];
  mockCountPending.mockResolvedValue(10);
  mockAgentProposalCap.mockResolvedValue(10); // blocked (10 >= 10) → proposed 15
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "cap-raise-1" },
    deduped: false,
  });
  mockNotifyPodWideProposal.mockResolvedValue(undefined);
  mockEmitSideEffects.mockResolvedValue(undefined);
});

describe("recommendRaiseProposalCapForAllAgents", () => {
  it("files a settings.update cap-raise when the agent is BLOCKED (pending >= cap)", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]); // hasPendingSettingsRaise → none
    queues.governanceCeilings.push([]); // hasCoveringCapCeiling → none

    const result = await recommendRaiseProposalCapForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = mockInsertPendingProposal.mock.calls[0]![0] as {
      proposalType: string;
      targetType: string;
      data: Record<string, unknown>;
    };
    expect(call.proposalType).toBe("settings.update");
    expect(call.targetType).toBe("settings");
    expect(call.data).toMatchObject({
      store: "governance_ceilings",
      op: "set",
      axis: "pending_proposal_cap",
      limitValue: 15,
      agentUserId: "agent-1",
    });
  });

  it("files nothing when the agent is under cap (pending < cap)", async () => {
    mockCountPending.mockResolvedValue(5); // 5 < 10
    queues.users.push([agentRow("agent-1")]);

    const result = await recommendRaiseProposalCapForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against an existing PENDING settings.update cap-raise for the agent", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([
      {
        data: {
          store: "governance_ceilings",
          axis: "pending_proposal_cap",
          agentUserId: "agent-1",
        },
      },
    ]);

    const result = await recommendRaiseProposalCapForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against a covering higher pending_proposal_cap ceiling", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([{ limitValue: 20 }]); // 20 >= proposed 15

    const result = await recommendRaiseProposalCapForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("bases the raise on the RESOLVED cap (explicit ceiling), not a hardcoded 10", async () => {
    mockAgentProposalCap.mockResolvedValue(30); // resolved cap 30 → proposed 45
    mockCountPending.mockResolvedValue(30);
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);

    await recommendRaiseProposalCapForAllAgents();

    const call = mockInsertPendingProposal.mock.calls[0]![0] as {
      data: { limitValue: number };
    };
    expect(call.data.limitValue).toBe(45);
  });
});
