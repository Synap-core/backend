import { describe, expect, it, vi } from "vitest";

/**
 * Fully mock @synap/database so the pure-helper unit tests never open a DB
 * connection (same pattern as pod-hygiene-near-dup.test.ts).
 */
vi.mock("@synap/database", () => ({
  db: {},
  proposals: {},
  users: {},
  governanceRules: {},
  insertPendingProposal: vi.fn(async () => ({
    proposal: { id: "proposal-1" },
    deduped: false,
  })),
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  ProposalStatus: {
    PENDING: "pending",
    APPROVED: "approved",
    AUTO_APPROVED: "auto_approved",
    REJECTED: "rejected",
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async () => undefined),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  computeQualification,
  qualifiesForWidenLane,
  computeDominantMotif,
  type LaneScanProposalRow,
} from "../governance-lane-scanner.js";

function makeRows(
  count: number,
  status: string,
  overrides: Partial<LaneScanProposalRow> = {}
): LaneScanProposalRow[] {
  return Array.from({ length: count }, (_, i) => ({
    proposalType: "update",
    targetType: "entity",
    targetId: `entity-${i}`,
    data: {},
    status,
    createdAt: new Date(),
    ...overrides,
  }));
}

describe("qualifiesForWidenLane", () => {
  it("qualifies at 500 total / 96.6% approve / 10.2% duplicate", () => {
    expect(
      qualifiesForWidenLane({
        total: 500,
        approveRate: 0.966,
        duplicateRate: 0.102,
      })
    ).toBe(true);
  });

  it("does NOT qualify at 31 total / 87.5% approve (below volume + rate floor)", () => {
    expect(
      qualifiesForWidenLane({
        total: 31,
        approveRate: 0.875,
        duplicateRate: 0.05,
      })
    ).toBe(false);
  });

  it("does NOT qualify when duplicateRate is at/over the 0.15 ceiling", () => {
    expect(
      qualifiesForWidenLane({
        total: 200,
        approveRate: 0.97,
        duplicateRate: 0.15,
      })
    ).toBe(false);
  });

  it("does NOT qualify when approveRate is at/below the 0.95 floor", () => {
    expect(
      qualifiesForWidenLane({
        total: 200,
        approveRate: 0.95,
        duplicateRate: 0.05,
      })
    ).toBe(false);
  });
});

describe("computeQualification", () => {
  it("computes approveRate and duplicateRate from raw proposal rows", () => {
    // 100 approved, unique targets (no duplicates), 5 rejected.
    const approved = makeRows(100, "approved");
    const rejected = makeRows(5, "rejected", { targetType: "document" });
    const q = computeQualification([...approved, ...rejected]);
    expect(q.total).toBe(105);
    expect(q.approveRate).toBeCloseTo(100 / 105, 4);
    expect(q.duplicateRate).toBe(0);
  });

  it("flags rows sharing a structural fingerprint (same mutate target) as duplicates", () => {
    const rows: LaneScanProposalRow[] = [
      {
        proposalType: "update",
        targetType: "entity",
        targetId: "same-entity",
        data: {},
        status: "approved",
        createdAt: new Date(),
      },
      {
        proposalType: "update",
        targetType: "entity",
        targetId: "same-entity",
        data: {},
        status: "approved",
        createdAt: new Date(),
      },
      {
        proposalType: "update",
        targetType: "entity",
        targetId: "different-entity",
        data: {},
        status: "approved",
        createdAt: new Date(),
      },
    ];
    const q = computeQualification(rows);
    expect(q.total).toBe(3);
    // 2 of 3 rows share a fingerprint (same target, both "mutate" class).
    expect(q.duplicateRate).toBeCloseTo(2 / 3, 4);
  });

  it("returns zeroed stats for an empty row set", () => {
    expect(computeQualification([])).toEqual({
      total: 0,
      approveRate: 0,
      duplicateRate: 0,
    });
  });
});

describe("computeDominantMotif", () => {
  it("picks the action pattern with the most APPROVED rows", () => {
    const rows: LaneScanProposalRow[] = [
      ...makeRows(10, "approved", {
        targetType: "entity",
        proposalType: "update",
      }),
      ...makeRows(3, "approved", {
        targetType: "document",
        proposalType: "create",
      }),
      ...makeRows(50, "rejected", {
        targetType: "document",
        proposalType: "create",
      }),
    ];
    const motif = computeDominantMotif(rows);
    expect(motif).toEqual({
      targetType: "entity",
      targetPattern: "entity.update",
    });
  });

  it("returns undefined when there are no approved rows", () => {
    const rows = makeRows(10, "rejected");
    expect(computeDominantMotif(rows)).toBeUndefined();
  });
});
