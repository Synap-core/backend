/**
 * Contract tests for the automation-health warden's DB + REPORTING tier
 * (`automation-health.ts`).
 *
 * DB-free the same way `recommend-tighten.test.ts` is: `db.select(...)` is
 * replaced by a per-table FIFO queue so each test hands back exactly the rows
 * the code would have read, in the exact call order it reads them. A dry queue
 * throws loudly, so a stray or missing DB call fails the test instead of
 * silently reading `undefined`.
 *
 * What is pinned here, and why each one is a defect class rather than a nicety:
 *   - ONE GROUPED proposal per owner, never one per automation (the 304-pending
 *     → 9-fingerprint queue-noise finding).
 *   - Items keyed by the SAME ref `proposals.rejectItem` writes dispositions
 *     under, so partial approval works through the existing door.
 *   - The re-nag guard suppresses BOTH an open finding and one decided inside
 *     the cooldown — the second half is load-bearing precisely because approval
 *     writes nothing.
 *   - Run counts come from the LEDGER query, never `automations.run_count`.
 *   - Every filed proposal notifies a human (`insertPendingProposal` fires no
 *     notification of its own — the gap that once made tighten invisible).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  queues,
  callCounts,
  mockInsertPendingProposal,
  mockNotifyPodWideProposal,
  mockEmitSideEffects,
} = vi.hoisted(() => ({
  queues: {
    automations: [] as unknown[][],
    automationRuns: [] as unknown[][],
    proposals: [] as unknown[][],
  },
  callCounts: { automations: 0, automationRuns: 0, proposals: 0 } as Record<
    string,
    number
  >,
  mockInsertPendingProposal: vi.fn(),
  mockNotifyPodWideProposal: vi.fn().mockResolvedValue(undefined),
  mockEmitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

// PARTIAL mock, not a total replacement. A total `vi.mock("@synap/database")`
// dies at COLLECTION time the moment any source file in the import graph starts
// using an export the mock forgot to list — the whole file goes dark rather than
// one test — which is why `__tripwires__/database-mock-total-ratchet.test.ts`
// pins their count. (It caught this file at 66 vs a baseline of 65.) Spreading
// `actual` means only the handful of names this test genuinely fakes are
// overridden; every other export keeps working.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const TABLES = {
    automations: {
      __key: "automations" as const,
      id: "automations.id",
      name: "automations.name",
      status: "automations.status",
      triggerType: "automations.trigger_type",
      workspaceId: "automations.workspace_id",
      createdBy: "automations.created_by",
      createdAt: "automations.created_at",
      // Present so a test can PROVE the warden never reads the denormalized
      // counter: touching it would show up as a selected column.
      runCount: "automations.run_count",
      lastRunAt: "automations.last_run_at",
    },
    automationRuns: {
      __key: "automationRuns" as const,
      automationId: "automation_runs.automation_id",
      status: "automation_runs.status",
    },
    proposals: {
      __key: "proposals" as const,
      proposalType: "proposals.proposal_type",
      status: "proposals.status",
      data: "proposals.data",
      reviewedAt: "proposals.reviewed_at",
    },
  };

  function shift(key: string): unknown[] {
    const q = queues[key as keyof typeof queues];
    callCounts[key] = (callCounts[key] ?? 0) + 1;
    if (!q || q.length === 0) {
      throw new Error(
        `automation-health.test mock: no queued response left for table "${key}" — ` +
          `either the code made an unexpected extra DB call, or the test under-queued it.`
      );
    }
    return q.shift()!;
  }

  /** Records the projection each select asked for, so a test can assert on it. */
  const selectedColumns: Record<string, unknown>[] = [];

  const select = vi.fn((projection?: Record<string, unknown>) => {
    if (projection) selectedColumns.push(projection);
    return {
      from: (table: { __key: string }) => {
        const builder: Record<string, unknown> = {};
        const chain = (..._a: unknown[]) => builder;
        builder.where = chain;
        builder.orderBy = chain;
        builder.groupBy = chain;
        builder.limit = (..._a: unknown[]) =>
          Promise.resolve(shift(table.__key));
        builder.then = (
          res: (v: unknown) => unknown,
          rej: (e: unknown) => unknown
        ) => Promise.resolve(shift(table.__key)).then(res, rej);
        return builder;
      },
    };
  });
  (select as unknown as { __selectedColumns: unknown[] }).__selectedColumns =
    selectedColumns;

  return {
    ...actual,
    db: { select },
    and: vi.fn((...c: unknown[]) => ({ and: c })),
    or: vi.fn((...c: unknown[]) => ({ or: c })),
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
    lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
    count: vi.fn(() => ({ count: true })),
    automations: TABLES.automations,
    automationRuns: TABLES.automationRuns,
    proposals: TABLES.proposals,
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

import { db } from "@synap/database";
import {
  scanAutomationHealth,
  AUTOMATION_HEALTH_ADVISORY_TYPE,
  RENAG_COOLDOWN_DAYS,
  type AutomationHealthAdvisoryData,
} from "./automation-health.js";
import { zeroRunItemRef } from "./automation-health-predicate.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function automationRow(over: { id: string } & Record<string, unknown>) {
  return {
    name: `automation ${over.id}`,
    status: "active",
    triggerType: "event",
    workspaceId: "ws-1",
    createdBy: "human-1",
    createdAt: daysAgo(60),
    ...over,
  };
}

/**
 * Queue one scan's three reads, in the order the implementation makes them:
 * candidates → run counts (skipped entirely when there are no candidates) →
 * prior advisories.
 */
function queueScan(opts: {
  candidates: Record<string, unknown>[];
  runCounts?: { automationId: string; runs: number }[];
  priorAdvisories?: unknown[];
}) {
  queues.automations.push(opts.candidates);
  if (opts.candidates.length > 0) {
    queues.automationRuns.push(opts.runCounts ?? []);
    queues.proposals.push(opts.priorAdvisories ?? []);
  }
}

function filedCalls() {
  return mockInsertPendingProposal.mock.calls.map(
    (c) =>
      c[0] as { data: AutomationHealthAdvisoryData } & Record<string, unknown>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queues.automations = [];
  queues.automationRuns = [];
  queues.proposals = [];
  callCounts.automations = 0;
  callCounts.automationRuns = 0;
  callCounts.proposals = 0;
  (
    db.select as unknown as { __selectedColumns: unknown[] }
  ).__selectedColumns.length = 0;
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "advisory-1" },
    deduped: false,
  });
});

describe("scanAutomationHealth — grouping", () => {
  it("files ONE grouped proposal per owner carrying N findings, never one proposal per automation", async () => {
    queueScan({
      candidates: [
        automationRow({ id: "a1" }),
        automationRow({ id: "a2" }),
        automationRow({ id: "a3" }),
      ],
    });

    const result = await scanAutomationHealth({ now: NOW });

    expect(result.findings).toBe(3);
    // THE INVARIANT: three findings, ONE review item.
    expect(result.proposalsFiled).toBe(1);
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(filedCalls()[0]!.data.findings).toHaveLength(3);
    expect(filedCalls()[0]!.proposalType).toBe(AUTOMATION_HEALTH_ADVISORY_TYPE);
  });

  it("partitions by OWNER — one proposal each, and no finding crosses owners", async () => {
    mockInsertPendingProposal
      .mockResolvedValueOnce({ proposal: { id: "adv-a" }, deduped: false })
      .mockResolvedValueOnce({ proposal: { id: "adv-b" }, deduped: false });
    queueScan({
      candidates: [
        automationRow({ id: "a1", createdBy: "human-1" }),
        automationRow({ id: "b1", createdBy: "human-2" }),
        automationRow({ id: "b2", createdBy: "human-2" }),
      ],
    });

    const result = await scanAutomationHealth({ now: NOW });

    expect(result.proposalsFiled).toBe(2);
    const byOwner = new Map(
      filedCalls().map((c) => [c.data.ownerUserId, c.data.findings])
    );
    expect(byOwner.get("human-1")!.map((f) => f.automationId)).toEqual(["a1"]);
    expect(
      byOwner
        .get("human-2")!
        .map((f) => f.automationId)
        .sort()
    ).toEqual(["b1", "b2"]);
    // Owner containment: the row is filed FOR the owner (0248 owner floor).
    for (const c of filedCalls()) {
      expect(c.subjectUserId).toBe(c.data.ownerUserId);
      expect(c.targetId).toBe(c.data.ownerUserId);
    }
  });

  it("keys each item by the ref proposals.rejectItem writes dispositions under", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1" }), automationRow({ id: "a2" })],
    });
    await scanAutomationHealth({ now: NOW });
    expect(filedCalls()[0]!.data.findings.map((f) => f.ref)).toEqual([
      zeroRunItemRef("a1"),
      zeroRunItemRef("a2"),
    ]);
  });

  it("files nothing when every candidate has run", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1" }), automationRow({ id: "a2" })],
      runCounts: [
        { automationId: "a1", runs: 4 },
        { automationId: "a2", runs: 1 },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result).toMatchObject({ proposalsFiled: 0, findings: 0 });
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });
});

describe("scanAutomationHealth — the run evidence is the LEDGER, not the counter", () => {
  it("reads run counts from automation_runs and never selects automations.run_count / last_run_at", async () => {
    queueScan({ candidates: [automationRow({ id: "a1" })] });
    await scanAutomationHealth({ now: NOW });

    // The ledger table WAS queried.
    expect(callCounts.automationRuns).toBe(1);

    // And the denormalized counters were never projected. If a future change
    // reads `run_count` instead, this goes red — which is the point: a counter
    // is a REPORTED number, and the whole finding rests on reading the effect.
    const projections = (
      db.select as unknown as { __selectedColumns: Record<string, unknown>[] }
    ).__selectedColumns;
    const allSelected = projections.flatMap((p) => Object.values(p));

    // POSITIVE FIRST — otherwise the two negative assertions below are VACUOUS.
    // They only mean anything if the sentinel column objects are what actually
    // reached the projection; if the mock's table override ever stopped winning
    // over the spread `...actual`, real Drizzle PgColumn objects would flow
    // through, `not.toContain("automations.run_count")` would pass for the
    // WRONG reason, and this test would certify a property it never checked.
    // Proven by mutation: dropping the `automations:` override turns THIS line
    // red, and leaves the negatives green.
    expect(allSelected).toContain("automations.id");
    expect(allSelected).toContain("automations.created_at");

    expect(allSelected).not.toContain("automations.run_count");
    expect(allSelected).not.toContain("automations.last_run_at");
  });

  it("never filters the ledger by run status — a failed or blocked run still proves the wire is live", async () => {
    // The count query's projection must not carry the status column, and the
    // detector must go quiet on the count alone.
    queueScan({
      candidates: [automationRow({ id: "a1" })],
      runCounts: [{ automationId: "a1", runs: 1 }],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.findings).toBe(0);

    const projections = (
      db.select as unknown as { __selectedColumns: Record<string, unknown>[] }
    ).__selectedColumns;
    const allSelected = projections.flatMap((p) => Object.values(p));
    // Same vacuity guard: prove the ledger projection is the sentinel one
    // before asserting what it does NOT contain.
    expect(allSelected).toContain("automation_runs.automation_id");
    expect(allSelected).not.toContain("automation_runs.status");
  });
});

describe("scanAutomationHealth — the re-nag guard", () => {
  it("suppresses an automation named by an OPEN advisory", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1" }), automationRow({ id: "a2" })],
      priorAdvisories: [
        {
          status: "pending",
          data: { findings: [{ automationId: "a1" }] },
        },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.findings).toBe(1);
    expect(filedCalls()[0]!.data.findings.map((f) => f.automationId)).toEqual([
      "a2",
    ]);
  });

  it("suppresses an automation named by an advisory DECIDED inside the cooldown — the half a pending-only guard misses", async () => {
    // This is the load-bearing half: approving an advisory writes NOTHING, so
    // without it the very next scan re-files every finding the human just
    // decided, forever. The query returns decided rows inside the window, so
    // the ids in them must suppress exactly like a pending row's.
    queueScan({
      candidates: [automationRow({ id: "a1" })],
      priorAdvisories: [
        {
          status: "approved",
          reviewedAt: new Date(NOW.getTime() - (RENAG_COOLDOWN_DAYS - 5) * DAY),
          data: {
            findings: [{ automationId: "a1" }],
          },
        },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result).toMatchObject({ proposalsFiled: 0, findings: 0 });
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("re-files once the cooldown has lapsed, even if the row is still returned", async () => {
    // A stale wire the human never fixed must RESURFACE rather than go silent
    // forever. Handed the decided row anyway (as a laxer SQL predicate would),
    // so this proves the JS re-check — not the WHERE clause — enforces the
    // window. A guard living only in SQL is invisible to any mocked query.
    queueScan({
      candidates: [automationRow({ id: "a1" })],
      priorAdvisories: [
        {
          status: "approved",
          reviewedAt: new Date(NOW.getTime() - (RENAG_COOLDOWN_DAYS + 1) * DAY),
          data: { findings: [{ automationId: "a1" }] },
        },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.proposalsFiled).toBe(1);
  });

  it("an EXPIRED/WITHDRAWN row (reviewedAt NULL) buys no silence — an expiry is not a decision", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1" })],
      priorAdvisories: [
        {
          status: "expired",
          reviewedAt: null,
          data: { findings: [{ automationId: "a1" }] },
        },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.findings).toBe(1);
  });

  it("ignores a prior advisory whose payload carries no findings array", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1" })],
      priorAdvisories: [
        { status: "pending", data: null },
        { status: "pending", data: {} },
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.findings).toBe(1);
  });
});

describe("scanAutomationHealth — the review item reaches a human", () => {
  it("notifies pod-wide for a freshly filed advisory", async () => {
    queueScan({
      candidates: [automationRow({ id: "a1", name: "Weekly digest" })],
    });
    await scanAutomationHealth({ now: NOW });
    expect(mockNotifyPodWideProposal).toHaveBeenCalledTimes(1);
    const arg = mockNotifyPodWideProposal.mock.calls[0]![0];
    expect(arg.proposalId).toBe("advisory-1");
    expect(arg.proposalType).toBe(AUTOMATION_HEALTH_ADVISORY_TYPE);
    expect(arg.description).toContain("Weekly digest");
  });

  it("does NOT re-notify on a deduped insert (that row already notified when first filed)", async () => {
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "advisory-1" },
      deduped: true,
    });
    queueScan({ candidates: [automationRow({ id: "a1" })] });
    await scanAutomationHealth({ now: NOW });
    expect(mockNotifyPodWideProposal).not.toHaveBeenCalled();
  });

  it("emits the proposal.created side effect", async () => {
    queueScan({ candidates: [automationRow({ id: "a1" })] });
    await scanAutomationHealth({ now: NOW });
    expect(mockEmitSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "proposal",
        action: "created",
        subjectId: "advisory-1",
      })
    );
  });

  it("stores the criteria so a finding stays reproducible after a retune", async () => {
    queueScan({ candidates: [automationRow({ id: "a1" })] });
    await scanAutomationHealth({ now: NOW, minAgeDays: 21 });
    expect(filedCalls()[0]!.data.criteria).toMatchObject({
      minAgeDays: 21,
      firingStatuses: ["active"],
      producerBackedTriggers: ["event", "cron", "webhook"],
    });
    expect(filedCalls()[0]!.data.findingKind).toBe("zero_run");
  });
});

describe("scanAutomationHealth — resilience", () => {
  it("one owner's insert failure never aborts the batch", async () => {
    mockInsertPendingProposal
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ proposal: { id: "adv-b" }, deduped: false });
    queueScan({
      candidates: [
        automationRow({ id: "a1", createdBy: "human-1" }),
        automationRow({ id: "b1", createdBy: "human-2" }),
      ],
    });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result.proposalsFiled).toBe(1);
    expect(result.proposalIds).toEqual(["adv-b"]);
  });

  it("makes no ledger or proposal query at all when there are no candidates", async () => {
    queueScan({ candidates: [] });
    const result = await scanAutomationHealth({ now: NOW });
    expect(result).toMatchObject({ proposalsFiled: 0, findings: 0 });
    expect(callCounts.automationRuns).toBe(0);
    expect(callCounts.proposals).toBe(0);
  });
});
