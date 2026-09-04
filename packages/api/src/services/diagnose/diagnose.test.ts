import { describe, expect, it } from "vitest";
import { computeAgentScorecard } from "./agent-scorecard.js";
import type { ScorecardProposalRow } from "./agent-scorecard.js";
import { summarizeGlobalHealth, type GlobalSignals } from "./global.js";
import { PROBE_ORDER } from "./resolve-object-kind.js";

/**
 * These lock the PURE hearts of the `diagnose` door — no DB. The DB tiers only
 * feed rows into these; if the ranking / rate math is right here, the door is
 * right. (The DB-floored reads reuse `userVisibleWhere` primitives that already
 * have their own tripwire coverage.)
 */

function proposalRow(
  over: Partial<ScorecardProposalRow>
): ScorecardProposalRow {
  return {
    proposalType: "create",
    targetType: "entity",
    targetId: "t1",
    data: { title: "Acme" },
    status: "approved",
    rejectionReason: null,
    reasonCode: null,
    revisionHistory: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    workspaceId: "ws1",
    ...over,
  };
}

describe("computeAgentScorecard", () => {
  it("computes counts, rates and a rejection histogram", () => {
    const rows: ScorecardProposalRow[] = [
      proposalRow({ status: "approved", targetId: "a" }),
      proposalRow({ status: "auto_approved", targetId: "b" }),
      proposalRow({
        status: "rejected",
        rejectionReason: "wrong-target",
        targetId: "c",
      }),
      proposalRow({
        status: "rejected",
        rejectionReason: "wrong-target",
        targetId: "d",
      }),
      proposalRow({ status: "pending", targetId: "e" }),
      proposalRow({
        status: "approved",
        targetId: "f",
        revisionHistory: [
          { at: new Date(), by: "u", before: {}, patch: {} } as never,
        ],
      }),
    ];

    const card = computeAgentScorecard(rows, {
      agentId: "agent-1",
      agentName: "Twin",
      agentType: "meta",
      todayCount: 3,
      cap: 10,
    });

    expect(card.counts.total).toBe(6);
    expect(card.counts.approved).toBe(3); // approved + auto_approved
    expect(card.counts.rejected).toBe(2);
    expect(card.counts.pending).toBe(1);
    expect(card.counts.revised).toBe(1);
    expect(card.rates.approveRate).toBe(0.5);
    expect(card.rates.rejectRate).toBe(0.3333); // rounded to 4dp by design
    expect(card.rejectionReasons[0]).toEqual({
      reason: "wrong-target",
      count: 2,
    });
    expect(card.dailyCap).toEqual({
      todayCount: 3,
      cap: 10,
      atOrOverCap: false,
    });
  });

  it("buckets on reasonCode first, falling back to normalized free-text — and collapses a matching free-text into the code bucket", () => {
    const rows: ScorecardProposalRow[] = [
      // Structured reject (0232), no free text — must still count.
      proposalRow({
        status: "rejected",
        reasonCode: "duplicate",
        rejectionReason: null,
        targetId: "a",
      }),
      // Pre-0232 free-text row that happens to spell out a known code —
      // collapses into the SAME "duplicate" bucket via lowercase compare.
      proposalRow({
        status: "rejected",
        reasonCode: null,
        rejectionReason: "Duplicate",
        targetId: "b",
      }),
      // Older free-text row with no structured code and no code match —
      // keeps its own bucket, must not vanish from the histogram.
      proposalRow({
        status: "rejected",
        reasonCode: null,
        rejectionReason: "  Not enough context  ",
        targetId: "c",
      }),
    ];

    const card = computeAgentScorecard(rows, {
      agentId: "agent-1",
      agentName: "Twin",
      agentType: "meta",
      todayCount: 0,
      cap: 10,
    });

    expect(card.rejectionReasons).toEqual(
      expect.arrayContaining([
        { reason: "duplicate", count: 2 },
        { reason: "not enough context", count: 1 },
      ])
    );
  });

  it("derives duplicateRate from the shared structural fingerprint", () => {
    // Three identical "create company Acme" attempts + one distinct → 3 of 4
    // land in a size>1 cluster.
    const rows: ScorecardProposalRow[] = [
      proposalRow({ data: { name: "Acme" }, targetId: "x1" }),
      proposalRow({ data: { name: "acme" }, targetId: "x2" }),
      proposalRow({ data: { name: " Acme " }, targetId: "x3" }),
      proposalRow({ data: { name: "Globex" }, targetId: "x4" }),
    ];
    const card = computeAgentScorecard(rows, {
      agentId: "a",
      agentName: null,
      agentType: null,
      todayCount: 0,
    });
    expect(card.rates.duplicateRate).toBeCloseTo(0.75, 5);
  });

  it("is safe on an empty history (no NaN rates)", () => {
    const card = computeAgentScorecard([], {
      agentId: "a",
      agentName: null,
      agentType: null,
      todayCount: 0,
    });
    expect(card.counts.total).toBe(0);
    expect(card.rates.approveRate).toBe(0);
    expect(card.rates.duplicateRate).toBe(0);
  });
});

describe("summarizeGlobalHealth", () => {
  const clean: GlobalSignals = {
    stuckHours: 24,
    stuck: [],
    failedFlows: [],
    backlog: { pending: 0, oldestAgeHours: null, mineOutsideLens: 0 },
    duplicateClusters: [],
    capabilities: { enabled: 3, unapproved: 0 },
    agentActivity: [],
  };

  it("is honest-empty when nothing is wrong", () => {
    const report = summarizeGlobalHealth(clean, { workspaceId: null });
    expect(report.status).toBe("ok");
    expect(report.summary).toContain("All clear");
    expect(report.summary).toContain("3 capability");
    // Every section present and ok.
    expect(report.sections).toHaveLength(6);
    expect(report.sections.every((s) => s.status === "ok")).toBe(true);
  });

  it("rolls up to degraded when a run is stuck", () => {
    const report = summarizeGlobalHealth(
      {
        ...clean,
        stuck: [
          {
            id: "r1",
            flowType: "session",
            flowName: "Deep work",
            ageHours: 150,
          },
        ],
      },
      { workspaceId: null }
    );
    expect(report.status).toBe("degraded");
    const stuckSection = report.sections.find((s) => s.key === "stuck_runs");
    expect(stuckSection?.status).toBe("degraded");
    expect(report.summary).toContain("still running");
  });

  it("flags a stale backlog as degraded, a fresh one as attention", () => {
    const stale = summarizeGlobalHealth(
      {
        ...clean,
        backlog: { pending: 5, oldestAgeHours: 72, mineOutsideLens: 0 },
      },
      { workspaceId: null }
    );
    expect(stale.sections.find((s) => s.key === "review_backlog")?.status).toBe(
      "degraded"
    );

    const fresh = summarizeGlobalHealth(
      {
        ...clean,
        backlog: { pending: 5, oldestAgeHours: 3, mineOutsideLens: 0 },
      },
      { workspaceId: null }
    );
    expect(fresh.sections.find((s) => s.key === "review_backlog")?.status).toBe(
      "attention"
    );
    expect(fresh.status).toBe("attention");
  });

  it("flags an agent over the daily cap as degraded", () => {
    const report = summarizeGlobalHealth(
      { ...clean, agentActivity: [{ agentId: "a", todayCount: 10, cap: 10 }] },
      { workspaceId: null }
    );
    expect(
      report.sections.find((s) => s.key === "agent_activity")?.status
    ).toBe("degraded");
  });
});

describe("PROBE_ORDER", () => {
  it("probes governance objects before the broad entity catch", () => {
    expect(PROBE_ORDER[0]).toBe("proposal");
    expect(PROBE_ORDER[PROBE_ORDER.length - 1]).toBe("entity");
    // No duplicates.
    expect(new Set(PROBE_ORDER).size).toBe(PROBE_ORDER.length);
  });
});
