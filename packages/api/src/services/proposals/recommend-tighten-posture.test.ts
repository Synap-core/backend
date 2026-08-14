import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeProposalFingerprint } from "./fingerprint.js";

/**
 * Contract tests for the governance TIGHTEN-POSTURE recommender
 * (`recommend-tighten-posture.ts`) — the channel-scoped twin of
 * recommend-tighten. Reuses the SAME reject-rate math (DECIDED denominator, mute
 * exclusion, MIN_CLUSTER_SIZE=5 / MIN_REJECT_RATE=0.9) keyed on CHANNEL, so the
 * tests pin the shared math plus the channel-specific dedupe rules.
 *
 * DB-free: per-table FIFO queue (mirror of the tighten test).
 */

const {
  queues,
  mockInsertPendingProposal,
  mockNotifyPodWideProposal,
  mockEmitSideEffects,
  mockResolvePodOwner,
} = vi.hoisted(() => ({
  queues: {
    proposals: [] as unknown[][],
    proposalClusterMutes: [] as unknown[][],
    channels: [] as unknown[][],
    configSettings: [] as unknown[][],
  },
  mockInsertPendingProposal: vi.fn(),
  mockNotifyPodWideProposal: vi.fn().mockResolvedValue(undefined),
  mockEmitSideEffects: vi.fn().mockResolvedValue(undefined),
  mockResolvePodOwner: vi.fn(),
}));

vi.mock("@synap/database", () => {
  const TABLES = {
    proposals: { __key: "proposals" as const },
    messages: { __key: "messages" as const },
    channels: { __key: "channels" as const },
    configSettings: { __key: "configSettings" as const },
    proposalClusterMutes: { __key: "proposalClusterMutes" as const },
  };

  function shift(key: string): unknown[] {
    const q = queues[key as keyof typeof queues];
    if (!q || q.length === 0) {
      throw new Error(
        `recommend-tighten-posture.test mock: no queued response for table "${key}"`
      );
    }
    return q.shift()!;
  }

  const select = vi.fn(() => ({
    from: (table: { __key: string }) => {
      const builder: Record<string, unknown> = {
        innerJoin: () => builder,
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
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    desc: vi.fn((a: unknown) => ({ desc: a })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
    proposals: TABLES.proposals,
    messages: TABLES.messages,
    channels: TABLES.channels,
    configSettings: TABLES.configSettings,
    proposalClusterMutes: TABLES.proposalClusterMutes,
    GUIDELINE_KEY: "guideline",
    insertPendingProposal: mockInsertPendingProposal,
    ProposalStatus: {
      PENDING: "pending",
      APPROVED: "approved",
      REJECTED: "rejected",
      AUTO_APPROVED: "auto_approved",
    },
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/events", () => ({ emitSideEffects: mockEmitSideEffects }));

vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: mockNotifyPodWideProposal,
}));

vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: mockResolvePodOwner,
}));

import { recommendTightenPostureForAllChannels } from "./recommend-tighten-posture.js";

/** A scan row — channelId defaults to "chan-1", motif entity.delete. */
function scanRow(
  id: string,
  channelId: string,
  status: string,
  over: { proposalType?: string; targetType?: string; targetId?: string } = {}
) {
  return {
    id,
    proposalType: over.proposalType ?? "delete",
    targetType: over.targetType ?? "entity",
    status,
    targetId: over.targetId ?? `t-${id}`,
    data: {},
    channelId,
  };
}

function resetQueues() {
  queues.proposals = [];
  queues.proposalClusterMutes = [];
  queues.channels = [];
  queues.configSettings = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQueues();
  mockResolvePodOwner.mockResolvedValue("owner-1");
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "posture-proposal-1" },
    deduped: false,
  });
  mockNotifyPodWideProposal.mockResolvedValue(undefined);
  mockEmitSideEffects.mockResolvedValue(undefined);
});

describe("recommendTightenPostureForAllChannels", () => {
  it("files a posture proposal for a channel with >= 5 rejects and >= 0.9 reject rate", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`r${i}`, "chan-1", "rejected")
    );
    queues.proposals.push(rows); // loadChannelProposals
    queues.proposalClusterMutes.push([]); // mute set
    queues.channels.push([{ id: "chan-1", workspaceId: "ws-1" }]);
    queues.proposals.push([]); // hasPendingPostureProposal
    queues.configSettings.push([]); // hasCoveringPostureGuideline

    const result = await recommendTightenPostureForAllChannels();

    expect(result.proposalsFiled).toBe(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      channelId: string;
      workspaceId: string | null;
      clusterSize: number;
      rejectRate: number;
    };
    expect(data.channelId).toBe("chan-1");
    expect(data.workspaceId).toBe("ws-1"); // resolved from channels map
    expect(data.clusterSize).toBe(5);
    expect(data.rejectRate).toBe(1);
  });

  it("below MIN_CLUSTER_SIZE (4 rejects) files nothing", async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      scanRow(`r${i}`, "chan-1", "rejected")
    );
    queues.proposals.push(rows);
    queues.proposalClusterMutes.push([]);
    // qualifying empty → no channels/pending/config reads.

    const result = await recommendTightenPostureForAllChannels();
    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("below MIN_REJECT_RATE (5 rejected + 1 approved = 0.833) files nothing", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        scanRow(`r${i}`, "chan-1", "rejected")
      ),
      scanRow("a0", "chan-1", "approved"),
    ];
    queues.proposals.push(rows);
    queues.proposalClusterMutes.push([]);

    const result = await recommendTightenPostureForAllChannels();
    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against an existing PENDING governance.tighten_posture for the channel", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`r${i}`, "chan-1", "rejected")
    );
    queues.proposals.push(rows);
    queues.proposalClusterMutes.push([]);
    queues.channels.push([{ id: "chan-1", workspaceId: null }]);
    queues.proposals.push([{ data: { channelId: "chan-1" } }]); // already pending
    // No configSettings entry — covering-guideline check must be short-circuited.

    const result = await recommendTightenPostureForAllChannels();
    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against a covering channel posture=propose guideline", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`r${i}`, "chan-1", "rejected")
    );
    queues.proposals.push(rows);
    queues.proposalClusterMutes.push([]);
    queues.channels.push([{ id: "chan-1", workspaceId: null }]);
    queues.proposals.push([]); // no pending
    queues.configSettings.push([{ value: { posture: "propose" } }]);

    const result = await recommendTightenPostureForAllChannels();
    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("mute exclusion — 6 muted + 6 live rejections on one channel scores 6/6=1.0 and fires", async () => {
    const muted = Array.from({ length: 6 }, (_, i) =>
      scanRow(`m${i}`, "chan-1", "rejected", { targetId: `mt-${i}` })
    );
    const live = Array.from({ length: 6 }, (_, i) =>
      scanRow(`l${i}`, "chan-1", "rejected", { targetId: `lt-${i}` })
    );
    const mutedFingerprints = muted.map((r) =>
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );
    queues.proposals.push([...muted, ...live]);
    queues.proposalClusterMutes.push(
      mutedFingerprints.map((fingerprint) => ({ fingerprint }))
    );
    queues.channels.push([{ id: "chan-1", workspaceId: "ws-1" }]);
    queues.proposals.push([]); // hasPendingPostureProposal
    queues.configSettings.push([]); // hasCoveringPostureGuideline

    const result = await recommendTightenPostureForAllChannels();
    expect(result.proposalsFiled).toBe(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      clusterSize: number;
      rejectRate: number;
    };
    expect(data.clusterSize).toBe(6);
    expect(data.rejectRate).toBe(1);
  });
});
