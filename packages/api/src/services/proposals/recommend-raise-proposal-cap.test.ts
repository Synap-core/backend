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

import {
  recommendRaiseProposalCapForAllAgents,
  requestRaiseProposalCap,
  findOpenRaiseProposalCapRequest,
} from "./recommend-raise-proposal-cap.js";

function agentRow(id: string, createdByUserId = "human-1", name = "Builder") {
  return { id, createdByUserId, name };
}

/** A PENDING `settings.update` cap-raise row as the dedup lookup reads it. */
function openRaiseRow(agentUserId: string, id = "open-raise-1") {
  return {
    id,
    data: {
      store: "governance_ceilings",
      axis: "pending_proposal_cap",
      agentUserId,
    },
  };
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

  it("the filed request CARRIES the display evidence the review card needs", async () => {
    // The card has no user lookup and no gate numbers of its own: whatever the
    // producer omits here, the reviewer never sees. `agentName` answers WHICH
    // agent, `currentLimit`+`pendingCount` answer WHY it ran out — and the
    // pendingCount must be the number this refusal actually resolved, not a
    // re-query that could disagree with it.
    queues.users.push([agentRow("agent-1", "human-1", "Builder")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);

    await recommendRaiseProposalCapForAllAgents();

    const call = mockInsertPendingProposal.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toMatchObject({
      agentName: "Builder",
      currentLimit: 10,
      pendingCount: 10,
    });
    // And the notification a human actually receives names the agent too.
    const notified = mockNotifyPodWideProposal.mock.calls[0]?.[0] as
      { description?: string } | undefined;
    expect(notified?.description).toContain("Builder");
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
    queues.proposals.push([openRaiseRow("agent-1")]);
    // A NON-covering ceiling, deliberately: if the dedup lookup stopped
    // matching, the scan would fall through to this check, find it does NOT
    // cover 15, and FILE — so `not.toHaveBeenCalled()` below discriminates the
    // two rules instead of passing on a swallowed error. (Queuing nothing here
    // would make a fall-through throw into the per-agent catch, which also
    // reports `proposalsFiled: 0` — a green run over a broken dedup.)
    queues.governanceCeilings.push([{ limitValue: 1 }]);

    const result = await recommendRaiseProposalCapForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
    expect(mockCountPending).toHaveBeenCalledWith("agent-1");
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

/**
 * The SINGLE-AGENT entry the F2 cap refusal calls. Same body, same dedup rule
 * as the cron scan above — only the entry shape differs. These pin the three
 * things the refusal depends on: it returns a LINKABLE id, a second refusal
 * gets the SAME id, and the request it files cannot eat the very budget it
 * exists to unblock.
 */
describe("requestRaiseProposalCap (the refusal's door)", () => {
  it("files ONE request and returns its id for the refusal to link", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);

    const result = await requestRaiseProposalCap("agent-1");

    expect(result).toMatchObject({
      proposalId: "cap-raise-1",
      deduped: false,
      cap: 10,
      proposedLimit: 15,
    });
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
  });

  it("a second refusal returns the SAME open request — no duplicate row", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([openRaiseRow("agent-1", "open-raise-77")]);
    // Non-covering, for the same discriminating reason as the scan's test.
    queues.governanceCeilings.push([{ limitValue: 1 }]);

    const result = await requestRaiseProposalCap("agent-1");

    expect(result).toMatchObject({
      proposalId: "open-raise-77",
      deduped: true,
    });
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("the filed request does NOT carry agentUserId — so it cannot consume the cap it is trying to raise", async () => {
    // THE DESIGN'S LOAD-BEARING FACT. `countPendingAgentProposals` counts rows
    // by `proposals.agentUserId`. If the cap-raise were stamped with the agent,
    // filing it would immediately occupy one of the slots the agent is blocked
    // on — and at the cap it would be the row that keeps it blocked forever.
    // It is filed on the OWNER's behalf (`createdBy` = the human, who decides).
    queues.users.push([agentRow("agent-1", "human-owner")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);

    await requestRaiseProposalCap("agent-1");

    const call = mockInsertPendingProposal.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call.agentUserId).toBeUndefined();
    expect(call.createdBy).toBe("human-owner");
    expect(call.subjectUserId).toBe("human-owner");
  });

  it("uses the pending/cap the GATE resolved instead of re-querying them", async () => {
    // The refusal quotes these numbers to the agent; a re-read could return
    // different ones and the message and the request would then disagree.
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([]);

    const result = await requestRaiseProposalCap("agent-1", {
      pendingCount: 30,
      cap: 30,
    });

    expect(mockCountPending).not.toHaveBeenCalled();
    expect(mockAgentProposalCap).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cap: 30, proposedLimit: 45 });
  });

  it("files nothing for an agent that is not actually at its cap", async () => {
    queues.users.push([agentRow("agent-1")]);

    const result = await requestRaiseProposalCap("agent-1", {
      pendingCount: 3,
      cap: 10,
    });

    expect(result).toBeNull();
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("files nothing when a covering ceiling already exists", async () => {
    queues.users.push([agentRow("agent-1")]);
    queues.proposals.push([]);
    queues.governanceCeilings.push([{ limitValue: 20 }]); // >= proposed 15

    expect(await requestRaiseProposalCap("agent-1")).toBeNull();
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("files nothing for an unknown agent id", async () => {
    queues.users.push([]);

    expect(await requestRaiseProposalCap("ghost")).toBeNull();
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });
});

describe("findOpenRaiseProposalCapRequest (read-only, for synap_governance)", () => {
  it("returns the open request's id and files NOTHING", async () => {
    queues.proposals.push([openRaiseRow("agent-1", "open-raise-9")]);

    expect(await findOpenRaiseProposalCapRequest("agent-1")).toBe(
      "open-raise-9"
    );
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("returns null when another agent's raise is the only one open", async () => {
    queues.proposals.push([openRaiseRow("agent-OTHER", "open-raise-9")]);

    expect(await findOpenRaiseProposalCapRequest("agent-1")).toBeNull();
  });
});
