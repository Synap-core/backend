import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the governance RAISE-CEILING recommender
 * (`recommend-raise-ceiling.ts`) — the numeric-limit twin of recommend-tighten.
 * Each `it` pins one qualify/dedupe rule so a regression can't silently break it.
 *
 * DB-free: `db.select(...)` is a per-table FIFO queue (mirror of the tighten
 * test); `resolveDailyWriteCeiling` is mocked to a fixed limit so the qualify
 * math is deterministic. With ceiling=10: atCeilingThreshold=ceil(10*0.8)=8,
 * proposedLimit=ceil(10*1.5)=15.
 */

const {
  queues,
  mockInsertPendingProposal,
  mockNotifyPodWideProposal,
  mockEmitSideEffects,
  mockResolveDailyWriteCeiling,
} = vi.hoisted(() => ({
  queues: {
    users: [] as unknown[][],
    events: [] as unknown[][],
    proposals: [] as unknown[][],
    governanceCeilings: [] as unknown[][],
  },
  mockInsertPendingProposal: vi.fn(),
  mockNotifyPodWideProposal: vi.fn().mockResolvedValue(undefined),
  mockEmitSideEffects: vi.fn().mockResolvedValue(undefined),
  mockResolveDailyWriteCeiling: vi.fn(),
}));

vi.mock("@synap/database", () => {
  const TABLES = {
    users: { __key: "users" as const },
    events: { __key: "events" as const },
    proposals: { __key: "proposals" as const },
    governanceCeilings: { __key: "governanceCeilings" as const },
  };

  function shift(key: string): unknown[] {
    const q = queues[key as keyof typeof queues];
    if (!q || q.length === 0) {
      throw new Error(
        `recommend-raise-ceiling.test mock: no queued response for table "${key}"`
      );
    }
    return q.shift()!;
  }

  const select = vi.fn(() => ({
    from: (table: { __key: string }) => {
      const builder: Record<string, unknown> = {
        where: () => builder,
        orderBy: () => builder,
        groupBy: () => builder,
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
    desc: vi.fn((a: unknown) => ({ desc: a })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
    gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
    count: vi.fn(() => ({ count: true })),
    sqlTemplate: Object.assign((..._a: unknown[]) => ({ __sql: true }), {
      raw: () => ({ __sql: true }),
    }),
    events: TABLES.events,
    users: TABLES.users,
    proposals: TABLES.proposals,
    governanceCeilings: TABLES.governanceCeilings,
    insertPendingProposal: mockInsertPendingProposal,
    ProposalStatus: { PENDING: "pending" },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  resolveDailyWriteCeiling: mockResolveDailyWriteCeiling,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/events", () => ({ emitSideEffects: mockEmitSideEffects }));

vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: mockNotifyPodWideProposal,
}));

import { recommendRaiseCeilingForAllAgents } from "./recommend-raise-ceiling.js";

function agentRow(id: string, createdByUserId = "human-1") {
  return { id, createdByUserId };
}
function dayCount(day: string, n: number) {
  return { day, n };
}

function resetQueues() {
  queues.users = [];
  queues.events = [];
  queues.proposals = [];
  queues.governanceCeilings = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQueues();
  mockResolveDailyWriteCeiling.mockResolvedValue(10); // threshold=8, proposed=15
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "raise-proposal-1" },
    deduped: false,
  });
  mockNotifyPodWideProposal.mockResolvedValue(undefined);
  mockEmitSideEffects.mockResolvedValue(undefined);
});

describe("recommendRaiseCeilingForAllAgents", () => {
  it("files a raise when the agent is at/near ceiling on >= MIN_DAYS_AT_CEILING (3) days", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.events.push([
      dayCount("2026-08-01", 9),
      dayCount("2026-08-02", 8),
      dayCount("2026-08-03", 10),
      dayCount("2026-08-04", 2),
    ]);
    queues.proposals.push([]); // hasPendingRaiseProposal
    queues.governanceCeilings.push([]); // hasCoveringHigherCeiling

    const result = await recommendRaiseCeilingForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      currentLimit: number;
      proposedLimit: number;
      evidence: { daysAtCeiling: number };
    };
    expect(data.currentLimit).toBe(10);
    expect(data.proposedLimit).toBe(15);
    expect(data.evidence.daysAtCeiling).toBe(3);
  });

  it("below MIN_DAYS_AT_CEILING (only 2 days >= threshold) files nothing", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.events.push([
      dayCount("2026-08-01", 9),
      dayCount("2026-08-02", 8),
      dayCount("2026-08-03", 3),
    ]);
    // No pending/ceilings queue entries — must bail before those DB calls.

    const result = await recommendRaiseCeilingForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against an existing PENDING governance.raise_ceiling for the agent", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.events.push([
      dayCount("2026-08-01", 9),
      dayCount("2026-08-02", 9),
      dayCount("2026-08-03", 9),
    ]);
    queues.proposals.push([{ data: { agentUserId: "agent-1" } }]); // already pending
    // No governanceCeilings entry — covering check must be short-circuited.

    const result = await recommendRaiseCeilingForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against a covering higher ceiling (an active ceiling >= proposedLimit)", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.events.push([
      dayCount("2026-08-01", 9),
      dayCount("2026-08-02", 9),
      dayCount("2026-08-03", 9),
    ]);
    queues.proposals.push([]); // no pending
    queues.governanceCeilings.push([{ limitValue: 20 }]); // 20 >= proposed 15

    const result = await recommendRaiseCeilingForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("payload contract — pod scope, agent id, limits, sample days capped at 20", async () => {
    const days = Array.from({ length: 25 }, (_, i) =>
      dayCount(`2026-08-${String(i + 1).padStart(2, "0")}`, 9)
    );
    queues.users.push([agentRow("agent-9", "human-42")]);
    queues.events.push(days);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "raise-payload-1" },
      deduped: false,
    });

    await recommendRaiseCeilingForAllAgents();

    const call = mockInsertPendingProposal.mock.calls[0]![0] as {
      workspaceId: string | null;
      targetType: string;
      targetId: string;
      proposalType: string;
      createdBy: string | null;
      data: {
        agentUserId: string;
        scopeKind: string;
        currentLimit: number;
        proposedLimit: number;
        evidence: { daysAtCeiling: number; sampleDays: unknown[] };
      };
    };
    expect(call.workspaceId).toBeNull();
    expect(call.targetType).toBe("governance");
    expect(call.targetId).toBe("agent-9");
    expect(call.proposalType).toBe("governance.raise_ceiling");
    expect(call.createdBy).toBe("human-42");
    expect(call.data.agentUserId).toBe("agent-9");
    expect(call.data.scopeKind).toBe("pod");
    expect(call.data.currentLimit).toBe(10);
    expect(call.data.proposedLimit).toBe(15);
    expect(call.data.evidence.daysAtCeiling).toBe(25);
    expect(call.data.evidence.sampleDays).toHaveLength(20);
  });
});
