import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeProposalFingerprint } from "./fingerprint.js";

/**
 * Contract tests for the governance TIGHTEN recommender
 * (`recommend-tighten.ts`) — zero coverage before this file, and the source of
 * two already-fixed axis-mismatch bugs (fingerprint-vs-motif qualification,
 * pending-dilutes-denominator). Each `it` below pins one defect class named in
 * the module's own doc-comments so a regression can't silently reintroduce
 * them.
 *
 * DB-free: `db.select(...)` is replaced by a per-table FIFO queue so each test
 * hands back exactly the rows the code under test would have read, in the
 * exact call order the implementation makes them. If a test's queue for a
 * table runs dry, the mock throws loudly (a stray/missing DB call fails the
 * test instead of silently reading `undefined`).
 */

const {
  queues,
  callCounts,
  mockInsertPendingProposal,
  mockNotifyPodWideProposal,
  mockEmitSideEffects,
} = vi.hoisted(() => {
  return {
    queues: {
      users: [] as unknown[][],
      proposals: [] as unknown[][],
      governanceRules: [] as unknown[][],
      proposalClusterMutes: [] as unknown[][],
    },
    callCounts: {
      users: 0,
      proposals: 0,
      governanceRules: 0,
      proposalClusterMutes: 0,
    } as Record<string, number>,
    mockInsertPendingProposal: vi.fn(),
    mockNotifyPodWideProposal: vi.fn().mockResolvedValue(undefined),
    mockEmitSideEffects: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@synap/database", () => {
  const TABLES = {
    users: { __key: "users" as const },
    proposals: { __key: "proposals" as const },
    governanceRules: { __key: "governanceRules" as const },
    proposalClusterMutes: { __key: "proposalClusterMutes" as const },
  };

  function shift(key: string): unknown[] {
    const q = queues[key as keyof typeof queues];
    callCounts[key] = (callCounts[key] ?? 0) + 1;
    if (!q || q.length === 0) {
      throw new Error(
        `recommend-tighten.test mock: no queued response left for table "${key}" — ` +
          `either the code made an unexpected extra DB call, or the test under-queued it.`
      );
    }
    return q.shift()!;
  }

  const select = vi.fn(() => ({
    from: (table: { __key: string }) => {
      const builder: {
        where: (...args: unknown[]) => typeof builder;
        orderBy: (...args: unknown[]) => typeof builder;
        limit: (...args: unknown[]) => Promise<unknown[]>;
        then: (
          res: (v: unknown) => unknown,
          rej: (e: unknown) => unknown
        ) => Promise<unknown>;
      } = {
        where: (..._args: unknown[]) => builder,
        orderBy: (..._args: unknown[]) => builder,
        limit: (..._args: unknown[]) => Promise.resolve(shift(table.__key)),
        then: (res, rej) => Promise.resolve(shift(table.__key)).then(res, rej),
      };
      return builder;
    },
  }));

  return {
    db: { select },
    and: vi.fn((...conds: unknown[]) => ({ and: conds })),
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    desc: vi.fn((a: unknown) => ({ desc: a })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
    users: TABLES.users,
    proposals: TABLES.proposals,
    governanceRules: TABLES.governanceRules,
    proposalClusterMutes: TABLES.proposalClusterMutes,
    insertPendingProposal: mockInsertPendingProposal,
    ProposalStatus: {
      PENDING: "pending",
      APPROVED: "approved",
      REJECTED: "rejected",
      AUTO_APPROVED: "auto_approved",
      REVERTED: "reverted",
      APPROVAL_FAILED: "approval_failed",
      WITHDRAWN: "withdrawn",
    },
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/events", () => ({ emitSideEffects: mockEmitSideEffects }));

vi.mock("../../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: mockNotifyPodWideProposal,
}));

import { recommendTightenForAllAgents } from "./recommend-tighten.js";

// ── fixtures ─────────────────────────────────────────────────────────────

function agentRow(id: string, createdByUserId = "human-1") {
  return { id, createdByUserId };
}

/** A `ScanRow` — motif defaults to "entity.delete" (targetType.proposalType). */
function scanRow(
  id: string,
  targetId: string,
  status: string,
  over: {
    proposalType?: string;
    targetType?: string;
    data?: unknown;
    reasonCode?: string | null;
    rejectionReason?: string | null;
  } = {}
) {
  return {
    id,
    proposalType: over.proposalType ?? "delete",
    targetType: over.targetType ?? "entity",
    status,
    targetId,
    data: over.data ?? {},
    // Default: NO reason at all — the pre-0232 / bare-reject shape every legacy
    // test above implicitly exercises. Must bucket as "unknown", never guessed.
    reasonCode: over.reasonCode ?? null,
    rejectionReason: over.rejectionReason ?? null,
  };
}

function resetQueues() {
  queues.users = [];
  queues.proposals = [];
  queues.governanceRules = [];
  queues.proposalClusterMutes = [];
  callCounts.users = 0;
  callCounts.proposals = 0;
  callCounts.governanceRules = 0;
  callCounts.proposalClusterMutes = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQueues();
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "tighten-proposal-1" },
    deduped: false,
  });
  mockNotifyPodWideProposal.mockResolvedValue(undefined);
  mockEmitSideEffects.mockResolvedValue(undefined);
});

// ── tests ────────────────────────────────────────────────────────────────

describe("recommendTightenForAllAgents", () => {
  it("groups by MOTIF, not by structural FINGERPRINT — N rejections of the same action on N different objects qualify as one cluster (the original axis-mismatch bug)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p${i}`, `target-${i}`, "rejected")
    );

    // Prove these rows genuinely have 5 DISTINCT structural fingerprints —
    // under the old fingerprint-grouping this scores 5 clusters of 1 and
    // never reaches MIN_CLUSTER_SIZE (5). The recommender must still fire.
    const fingerprints = new Set(
      rows.map((r) =>
        computeProposalFingerprint({
          proposalType: r.proposalType,
          targetType: r.targetType,
          targetId: r.targetId,
          data: r.data,
        })
      )
    );
    expect(fingerprints.size).toBe(5);

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rows); // loadAgentProposals
    queues.proposals.push([]); // hasPendingTightenProposal: none pending
    queues.governanceRules.push([]); // hasCoveringProposeRule: none

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      targetPattern: string;
      evidence: { clusterSize: number };
    };
    expect(data.targetPattern).toBe("entity.delete");
    expect(data.evidence.clusterSize).toBe(5);
  });

  it("denominator = DECIDED only — PENDING rows of the same motif must not dilute the reject rate (9 rejected + 2 pending fires; would NOT fire if pending counted)", async () => {
    const rejected = Array.from({ length: 9 }, (_, i) =>
      scanRow(`rej-${i}`, `target-${i}`, "rejected")
    );
    const pending = Array.from({ length: 2 }, (_, i) =>
      scanRow(`pend-${i}`, `pending-target-${i}`, "pending")
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push([...rejected, ...pending]); // loadAgentProposals
    queues.proposals.push([]); // hasPendingTightenProposal
    queues.governanceRules.push([]); // hasCoveringProposeRule

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      evidence: {
        clusterSize: number;
        totalForShape: number;
        rejectRate: number;
      };
    };
    // 9/9 decided = 1.0 — NOT 9/11 = 0.818, which is < MIN_REJECT_RATE (0.9)
    // and would have silently suppressed this exact recommendation.
    expect(data.evidence.clusterSize).toBe(9);
    expect(data.evidence.totalForShape).toBe(9);
    expect(data.evidence.rejectRate).toBe(1);
  });

  it("mute set is excluded from BOTH numerator and denominator — 6 muted + 6 live rejections does not dilute to 6/12=0.5 (it scores 6/6=1.0 and fires)", async () => {
    const muted = Array.from({ length: 6 }, (_, i) =>
      scanRow(`muted-${i}`, `muted-target-${i}`, "rejected")
    );
    const live = Array.from({ length: 6 }, (_, i) =>
      scanRow(`live-${i}`, `live-target-${i}`, "rejected")
    );
    const mutedFingerprints = muted.map((r) =>
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push(
      mutedFingerprints.map((fingerprint) => ({ fingerprint }))
    );
    queues.proposals.push([...muted, ...live]); // loadAgentProposals
    queues.proposals.push([]); // hasPendingTightenProposal
    queues.governanceRules.push([]); // hasCoveringProposeRule

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const data = mockInsertPendingProposal.mock.calls[0]![0].data as {
      evidence: {
        clusterSize: number;
        totalForShape: number;
        rejectRate: number;
      };
    };
    // If muting had only stripped the numerator, this would read 6/12 = 0.5
    // and be silently suppressed. Correct: 6 live / 6 live decided = 1.0.
    expect(data.evidence.clusterSize).toBe(6);
    expect(data.evidence.totalForShape).toBe(6);
    expect(data.evidence.rejectRate).toBe(1);
  });

  it("a motif whose rejections are ENTIRELY muted vanishes from the scan — files nothing", async () => {
    const allMuted = Array.from({ length: 6 }, (_, i) =>
      scanRow(`m-${i}`, `t-${i}`, "rejected")
    );
    const mutedFingerprints = allMuted.map((r) =>
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push(
      mutedFingerprints.map((fingerprint) => ({ fingerprint }))
    );
    queues.proposals.push(allMuted); // loadAgentProposals
    // No further proposals/governanceRules queue entries: if the code tried
    // to qualify this motif it would call hasPendingTightenProposal and the
    // mock would throw on the empty queue — that failure itself pins the
    // "vanishes, no further DB work" behaviour.

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("below MIN_CLUSTER_SIZE (5) files nothing", async () => {
    const rejected = Array.from({ length: 4 }, (_, i) =>
      scanRow(`p${i}`, `t${i}`, "rejected")
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rejected); // loadAgentProposals
    // No pending/governanceRules queue entries needed — the cluster-size
    // floor must reject before any further DB call is made.

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("below MIN_REJECT_RATE (0.9) files nothing (5 rejected + 1 approved = 0.833)", async () => {
    const rejected = Array.from({ length: 5 }, (_, i) =>
      scanRow(`rej-${i}`, `t-${i}`, "rejected")
    );
    const approved = [scanRow("appr-0", "t-approved", "approved")];

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push([...rejected, ...approved]); // loadAgentProposals

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("dedupes against an existing PENDING governance.tighten_lane for the same (agent, motif) — never calls hasCoveringProposeRule or insertPendingProposal", async () => {
    const rejected = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p${i}`, `t${i}`, "rejected")
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rejected); // loadAgentProposals
    queues.proposals.push([
      { data: { agentUserId: "agent-1", targetPattern: "entity.delete" } },
    ]); // hasPendingTightenProposal: already pending for this exact (agent, motif)
    // No governanceRules queue entry: consuming one would throw and fail the
    // test — pinning that the covering-rule check is short-circuited.

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it.each([
    ["exact", "entity.delete"],
    ["subject.* glob", "entity.*"],
    ["global wildcard", "*"],
  ])(
    "dedupes against a covering verdict:'propose' rule (%s pattern)",
    async (_label, coveringPattern) => {
      const rejected = Array.from({ length: 5 }, (_, i) =>
        scanRow(`p${i}`, `t${i}`, "rejected")
      );

      queues.users.push([agentRow("agent-1")]);
      queues.proposalClusterMutes.push([]);
      queues.proposals.push(rejected); // loadAgentProposals
      queues.proposals.push([]); // hasPendingTightenProposal: none pending
      queues.governanceRules.push([
        {
          targetKind: "action",
          targetPattern: coveringPattern,
          verdict: "propose",
        },
      ]);

      const result = await recommendTightenForAllAgents();

      expect(result.proposalsFiled).toBe(0);
      expect(mockInsertPendingProposal).not.toHaveBeenCalled();
    }
  );

  it("an existing 'auto' rule (not 'propose') is NOT a covering rule — an agent that was widened but is now consistently rejected still fires", async () => {
    const rejected = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p${i}`, `t${i}`, "rejected")
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rejected);
    queues.proposals.push([]); // hasPendingTightenProposal
    queues.governanceRules.push([
      { targetKind: "action", targetPattern: "entity.delete", verdict: "auto" },
    ]);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
  });

  it("payload contract — verdict/scopeKind/targetKind/targetPattern are exact, and sampleProposalIds is capped at SAMPLE_CAP (20)", async () => {
    const rejected = Array.from({ length: 25 }, (_, i) =>
      scanRow(`p${i}`, `t${i}`, "rejected")
    );

    queues.users.push([agentRow("agent-9", "human-42")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rejected);
    queues.proposals.push([]); // hasPendingTightenProposal
    queues.governanceRules.push([]); // hasCoveringProposeRule

    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "tighten-payload-1" },
      deduped: false,
    });

    await recommendTightenForAllAgents();

    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    const call = mockInsertPendingProposal.mock.calls[0]![0] as {
      workspaceId: string | null;
      targetType: string;
      targetId: string;
      proposalType: string;
      createdBy: string | null;
      data: {
        agentUserId: string;
        targetKind: string;
        targetPattern: string;
        scopeKind: string;
        verdict: string;
        evidence: {
          clusterSize: number;
          rejectRate: number;
          totalForShape: number;
          sampleProposalIds: string[];
        };
      };
    };

    expect(call.workspaceId).toBeNull();
    expect(call.targetType).toBe("governance");
    expect(call.targetId).toBe("agent-9");
    expect(call.proposalType).toBe("governance.tighten_lane");
    expect(call.createdBy).toBe("human-42");

    expect(call.data.agentUserId).toBe("agent-9");
    expect(call.data.targetKind).toBe("action");
    expect(call.data.targetPattern).toBe("entity.delete");
    expect(call.data.scopeKind).toBe("pod");
    expect(call.data.verdict).toBe("propose");
    expect(call.data.evidence.clusterSize).toBe(25);
    expect(call.data.evidence.totalForShape).toBe(25);
    expect(call.data.evidence.rejectRate).toBe(1);
    expect(call.data.evidence.sampleProposalIds).toHaveLength(20);
    expect(call.data.evidence.sampleProposalIds).toEqual(
      rejected.slice(0, 20).map((r) => r.id)
    );
  });

  it("loads the mute set ONCE per scan, not per agent or per motif", async () => {
    // Agent 1: one qualifying motif (entity.delete).
    const agent1Rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`a1-del-${i}`, `a1-t${i}`, "rejected")
    );
    // Agent 2: two qualifying motifs (entity.delete and entity.merge).
    const agent2DeleteRows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`a2-del-${i}`, `a2-del-t${i}`, "rejected")
    );
    const agent2MergeRows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`a2-merge-${i}`, `a2-merge-t${i}`, "rejected", {
        proposalType: "merge",
      })
    );

    queues.users.push([agentRow("agent-1"), agentRow("agent-2")]);
    // Exactly ONE entry queued for the mute-set load — if the implementation
    // re-queries per agent or per motif, the second/third consumer finds the
    // queue empty and the mock throws, failing this test.
    queues.proposalClusterMutes.push([]);

    // agent-1: loadAgentProposals, then qualify entity.delete.
    queues.proposals.push(agent1Rows);
    queues.proposals.push([]); // hasPendingTightenProposal (entity.delete)
    queues.governanceRules.push([]); // hasCoveringProposeRule (entity.delete)

    // agent-2: loadAgentProposals, then qualify BOTH motifs (merge sorts
    // first — same count, but insertion/sort is stable enough either way we
    // just need both to be processed).
    queues.proposals.push([...agent2DeleteRows, ...agent2MergeRows]);
    queues.proposals.push([]); // hasPendingTightenProposal (motif A)
    queues.governanceRules.push([]); // hasCoveringProposeRule (motif A)
    queues.proposals.push([]); // hasPendingTightenProposal (motif B)
    queues.governanceRules.push([]); // hasCoveringProposeRule (motif B)

    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "tighten-x" },
      deduped: false,
    });

    const result = await recommendTightenForAllAgents();

    expect(callCounts.proposalClusterMutes).toBe(1);
    // 3 total qualifying motifs across both agents: agent-1's entity.delete,
    // agent-2's entity.delete, agent-2's entity.merge.
    expect(result.proposalsFiled).toBe(3);
  });
});

// ── reason-awareness + classification ────────────────────────────────────
//
// The recommender used to count rejections and never read WHY. These pin the
// three behaviours that fix: bucketing, the mechanical-vs-judgment split, and
// the unknown-reason fallback that keeps the old behaviour when there is no
// signal to reclassify on.

describe("recommendTightenForAllAgents — reason-aware classification", () => {
  /** Queue exactly the DB responses the JUDGMENT (rule) path consumes. */
  function queueRulePath(rows: unknown[], agent = agentRow("agent-1")) {
    queues.users.push([agent]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rows); // loadAgentProposals
    queues.proposals.push([]); // hasPendingFinding
    queues.governanceRules.push([]); // hasCoveringProposeRule
  }

  /**
   * The MECHANICAL (advisory) path consumes one FEWER call: the covering-rule
   * check is a rule-redundancy check and is skipped. Queueing no governanceRules
   * response is itself the assertion — a stray call throws.
   */
  function queueAdvisoryPath(rows: unknown[], agent = agentRow("agent-1")) {
    queues.users.push([agent]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rows); // loadAgentProposals
    queues.proposals.push([]); // hasPendingFinding
  }

  function filedCall() {
    return mockInsertPendingProposal.mock.calls[0]![0] as {
      proposalType: string;
      data: {
        verdict?: string;
        advisoryKind?: string;
        suggestedRemedy?: string;
        targetPattern: string;
        evidence: {
          dominantReason: string;
          reasonHistogram: Record<string, number>;
          faultClass: string;
          clusterSize: number;
        };
      };
    };
  }

  it("reads reasonCode and reports the dominant reason + histogram in the evidence", async () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        scanRow(`nr-${i}`, `t-${i}`, "rejected", {
          reasonCode: "not_relevant",
        })
      ),
      scanRow("bd-0", "t-bd", "rejected", { reasonCode: "bad_data" }),
    ];
    queueRulePath(rows);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = filedCall();
    expect(call.data.evidence.dominantReason).toBe("not_relevant");
    expect(call.data.evidence.reasonHistogram).toEqual({
      not_relevant: 4,
      bad_data: 1,
    });
  });

  it("falls back to free-text rejectionReason for pre-0232 rows, trimmed + lowercased, collapsing onto the matching code's bucket", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`ft-${i}`, `t-${i}`, "rejected", {
        // No structured code (pre-migration-0232 row) — the free text carries it.
        rejectionReason: i === 0 ? "  Duplicate  " : "duplicate",
      })
    );
    queueAdvisoryPath(rows);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = filedCall();
    // All 5 collapsed into ONE bucket — the trimmed/lowercased free text is the
    // same key as the structured code, so legacy rows classify identically.
    expect(call.data.evidence.reasonHistogram).toEqual({ duplicate: 5 });
    expect(call.proposalType).toBe("governance.advisory");
  });

  it("an unknown reasonCode outside the pinned taxonomy is IGNORED in favour of the free text (precedence, not first-non-null)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`x-${i}`, `t-${i}`, "rejected", {
        reasonCode: "some_code_we_never_shipped",
        rejectionReason: "Not relevant",
      })
    );
    queueRulePath(rows);

    await recommendTightenForAllAgents();

    const call = filedCall();
    expect(call.data.evidence.reasonHistogram).toEqual({ "not relevant": 5 });
    expect(call.data.evidence.faultClass).toBe("judgment");
  });

  it.each([["duplicate"], ["wrong_kind_or_facet"], ["wrong_link_type"]])(
    "MECHANICAL dominant reason (%s) files an ADVISORY, never a rule — no verdict, and the covering-rule check is skipped",
    async (reasonCode) => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        scanRow(`m-${i}`, `t-${i}`, "rejected", { reasonCode })
      );
      queueAdvisoryPath(rows);

      const result = await recommendTightenForAllAgents();

      expect(result.proposalsFiled).toBe(1);
      const call = filedCall();
      expect(call.proposalType).toBe("governance.advisory");
      // The whole point: a `propose` rule cannot deduplicate or repair a
      // malformed write, so the payload must carry NO verdict at all.
      expect(call.data.verdict).toBeUndefined();
      expect(call.data.advisoryKind).toBe("mechanical_fault");
      expect(call.data.suggestedRemedy).toBeTruthy();
      expect(call.data.evidence.faultClass).toBe("mechanical");
      expect(call.data.evidence.dominantReason).toBe(reasonCode);
      // Same evidence as the rule path — only the REMEDY differs.
      expect(call.data.evidence.clusterSize).toBe(6);
    }
  );

  it("the live-pod case: playbook.create rejected as duplicate does NOT file a tighten_lane (pinning it to review fixes nothing — those writes are already pending review)", async () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      scanRow(`pb-${i}`, `pb-t-${i}`, "rejected", {
        targetType: "playbook",
        proposalType: "create",
        reasonCode: "duplicate",
      })
    );
    queueAdvisoryPath(rows);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = filedCall();
    expect(call.data.targetPattern).toBe("playbook.create");
    expect(call.proposalType).not.toBe("governance.tighten_lane");
    expect(call.proposalType).toBe("governance.advisory");
  });

  it.each([
    ["not_relevant"],
    ["bad_data"],
    ["wrong_workspace"],
    ["wrong_entity"],
  ])(
    "JUDGMENT dominant reason (%s) keeps the tighten_lane rule — the write was well-formed but unwanted",
    async (reasonCode) => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        scanRow(`j-${i}`, `t-${i}`, "rejected", { reasonCode })
      );
      queueRulePath(rows);

      const result = await recommendTightenForAllAgents();

      expect(result.proposalsFiled).toBe(1);
      const call = filedCall();
      expect(call.proposalType).toBe("governance.tighten_lane");
      expect(call.data.verdict).toBe("propose");
      expect(call.data.evidence.faultClass).toBe("judgment");
      expect(call.data.evidence.dominantReason).toBe(reasonCode);
    }
  );

  it("UNREASONED rejections bucket as 'unknown' and keep TODAY's behaviour (rule) — never fabricated into a reason", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`u-${i}`, `t-${i}`, "rejected")
    );
    queueRulePath(rows);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = filedCall();
    expect(call.proposalType).toBe("governance.tighten_lane");
    expect(call.data.evidence.dominantReason).toBe("unknown");
    expect(call.data.evidence.reasonHistogram).toEqual({ unknown: 5 });
    expect(call.data.evidence.faultClass).toBe("judgment");
  });

  it("a motif MOSTLY unreasoned keeps the rule even when a mechanical reason is present — one loud 'duplicate' must not reclassify an unreasoned cluster", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        scanRow(`u-${i}`, `t-${i}`, "rejected")
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        scanRow(`d-${i}`, `td-${i}`, "rejected", { reasonCode: "duplicate" })
      ),
    ];
    queueRulePath(rows);

    const result = await recommendTightenForAllAgents();

    const call = filedCall();
    expect(result.proposalsFiled).toBe(1);
    expect(call.data.evidence.dominantReason).toBe("unknown");
    expect(call.proposalType).toBe("governance.tighten_lane");
  });

  it("a TIE between 'unknown' and a mechanical reason resolves to unknown (rule) — a tie is not evidence to reclassify", async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) =>
        scanRow(`u-${i}`, `t-${i}`, "rejected")
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        scanRow(`d-${i}`, `td-${i}`, "rejected", { reasonCode: "duplicate" })
      ),
    ];
    queueRulePath(rows);

    await recommendTightenForAllAgents();

    const call = filedCall();
    expect(call.data.evidence.dominantReason).toBe("unknown");
    expect(call.proposalType).toBe("governance.tighten_lane");
  });

  it("the reason histogram is built over the SAME filtered population as the count — muted rejections contribute no reasons", async () => {
    const muted = Array.from({ length: 6 }, (_, i) =>
      scanRow(`muted-${i}`, `muted-t-${i}`, "rejected", {
        reasonCode: "duplicate",
      })
    );
    const live = Array.from({ length: 5 }, (_, i) =>
      scanRow(`live-${i}`, `live-t-${i}`, "rejected", {
        reasonCode: "not_relevant",
      })
    );
    const mutedFingerprints = muted.map((r) =>
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push(
      mutedFingerprints.map((fingerprint) => ({ fingerprint }))
    );
    queues.proposals.push([...muted, ...live]);
    queues.proposals.push([]); // hasPendingFinding
    queues.governanceRules.push([]); // hasCoveringProposeRule (judgment path)

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    const call = filedCall();
    // If the muted `duplicate` rows leaked into the histogram they would be the
    // plurality (6 > 5) and would flip this motif to an ADVISORY — measuring a
    // different population than the rate was computed over.
    expect(call.data.evidence.reasonHistogram).toEqual({ not_relevant: 5 });
    expect(call.proposalType).toBe("governance.tighten_lane");
  });

  it("dedupes across BOTH finding types — an open ADVISORY suppresses a tighten_lane for the same (agent, motif)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p-${i}`, `t-${i}`, "rejected", { reasonCode: "not_relevant" })
    );

    queues.users.push([agentRow("agent-1")]);
    queues.proposalClusterMutes.push([]);
    queues.proposals.push(rows); // loadAgentProposals
    // ONE query returns pending findings of BOTH types; this one is an advisory
    // for the same (agent, motif). No governanceRules entry is queued — reaching
    // the covering-rule check would throw and fail this test.
    queues.proposals.push([
      {
        data: {
          agentUserId: "agent-1",
          targetPattern: "entity.delete",
          advisoryKind: "mechanical_fault",
        },
      },
    ]);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(0);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("an advisory is NOT suppressed by a covering propose rule — the rule does not fix the code fault", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p-${i}`, `t-${i}`, "rejected", { reasonCode: "duplicate" })
    );
    // No governanceRules response queued: if the advisory path consulted the
    // covering-rule check at all, the mock would throw.
    queueAdvisoryPath(rows);

    const result = await recommendTightenForAllAgents();

    expect(result.proposalsFiled).toBe(1);
    expect(filedCall().proposalType).toBe("governance.advisory");
  });

  it("notifies pod-wide for an advisory too — a finding nobody sees is not a finding", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      scanRow(`p-${i}`, `t-${i}`, "rejected", { reasonCode: "duplicate" })
    );
    queueAdvisoryPath(rows);

    await recommendTightenForAllAgents();

    expect(mockNotifyPodWideProposal).toHaveBeenCalledTimes(1);
    const arg = mockNotifyPodWideProposal.mock.calls[0]![0] as {
      proposalType: string;
      description: string;
      agentUserId: string;
    };
    expect(arg.proposalType).toBe("governance.advisory");
    expect(arg.agentUserId).toBe("agent-1");
    expect(arg.description).toContain("duplicate");
  });
});
