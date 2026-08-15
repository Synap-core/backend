import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the approval-patterns projection (`approval-patterns.ts`).
 *
 * Each `it` pins one of the three decisions the module's doc-comment says decide
 * whether it measures anything real — plus the funnel property that lets a
 * reader tell "nothing qualified" from "I am broken". These are the mistakes
 * this codebase has ALREADY made once each, so they get a test apiece:
 *   1. keyed on motif, not on the object-identity fingerprint
 *   2. `auto_approved` is a SYSTEM verdict and must never count as human signal
 *   3. a sub-3s verdict is a rubber stamp, not a decision
 *
 * DB-FREE, and honest about what that costs: `db.select(...)` is replaced by a
 * chainable stub draining a FIFO queue, so this file proves the GROUPING logic
 * and nothing about the SQL. The `proposals → automation_step_runs →
 * automation_runs` join itself is exercised by the DB-backed
 * `workflow-place` test, which walks the identical chain. Neither file alone
 * covers both halves — that is deliberate and recorded here so nobody reads a
 * green run as proof the join works.
 */

const { queue } = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock("@synap/database", async (importOriginal) => {
  // importOriginal, NOT a bare factory: a whole-module mock would null out every
  // sibling export this file's subject imports (proposals, automationRuns, the
  // ProposalStatus enum), and the suite would collect zero tests instead of
  // failing loudly. That exact mistake cost a previous suite its coverage.
  const actual = await importOriginal<Record<string, unknown>>();

  // Every builder method returns `this`; awaiting the chain shifts one result.
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => {
    if (queue.length === 0) {
      throw new Error(
        "approval-patterns issued more DB reads than the test queued — " +
          "a stray query must fail loudly, not read undefined"
      );
    }
    return Promise.resolve(queue.shift()).then(resolve);
  };

  return { ...actual, db: { select: () => chain } };
});

const { scanApprovalPatterns } = await import("./approval-patterns.js");

/** Minutes, in ms — comfortably past the 3s deliberation floor. */
const DELIBERATED = 5 * 60_000;

let seq = 0;
function row(over: Partial<Record<string, unknown>> = {}) {
  const createdAt = new Date("2026-08-03T10:00:00Z");
  return {
    id: `p${++seq}`,
    proposalType: "create",
    targetType: "entity",
    targetId: `t${seq}`,
    status: "approved",
    reviewedBy: "human-1",
    createdAt,
    reviewedAt: new Date(createdAt.getTime() + DELIBERATED),
    triggerPayload: { eventType: "dev.commit" },
    ...over,
  };
}

/** Queue the joined scan, then the separate decided-total count. */
function seed(rows: unknown[], decidedTotal = rows.length) {
  queue.length = 0;
  queue.push(rows, [{ n: decidedTotal }]);
}

beforeEach(() => {
  seq = 0;
  queue.length = 0;
});

describe("approval patterns projection", () => {
  it("groups on the ACTION motif, so the same shape over different objects is ONE pattern", async () => {
    // The defect this pins: keying on the structural fingerprint would embed
    // `id:<targetId>` and shatter these two into clusters of size 1 — exactly
    // how the tighten recommender came to fire zero times.
    seed([row({ targetId: "entity-a" }), row({ targetId: "entity-b" })]);

    const { patterns } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns).toHaveLength(1);
    expect(patterns[0].motif).toBe("entity.create");
    expect(patterns[0].eventType).toBe("dev.commit");
    expect(patterns[0].approvedByHuman).toBe(2);
    // ≥2 distinct subjects is what proves "same shape, different objects".
    expect(patterns[0].distinctSubjects).toBe(2);
  });

  it("splits patterns that share a motif but arrive from DIFFERENT events", async () => {
    // The event axis is the whole point: the same write reached by two different
    // triggers is two different things to automate.
    seed([
      row({ triggerPayload: { eventType: "dev.commit" } }),
      row({ triggerPayload: { eventType: "ci.workflow_run" } }),
    ]);

    const { patterns } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns).toHaveLength(2);
    expect(patterns.map((p) => p.eventType).sort()).toEqual([
      "ci.workflow_run",
      "dev.commit",
    ]);
  });

  it("never counts an auto_approved row as human approval", async () => {
    // Governance decided; no person looked. Folding this into the signal would
    // let the system cite its own past decisions as evidence to widen further —
    // the loop governance exists to close.
    //
    // The fixture keeps `reviewedBy` SET and the elapsed time past the
    // deliberation floor ON PURPOSE, so the row would satisfy every other test
    // for a human verdict and ONLY the auto-approved short-circuit can exclude
    // it. An earlier version of this test used `reviewedBy: null`, which blocked
    // the row independently — deleting the guard left the suite green. Verified
    // by mutation: removing the short-circuit now turns this red.
    seed([row({ status: "auto_approved" })]);

    const { patterns, funnel } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns[0].autoApproved).toBe(1);
    expect(patterns[0].approvedByHuman).toBe(0);
    expect(funnel.humanDecided).toBe(0);
  });

  it("treats a sub-3s verdict as a rubber stamp, not a decision", async () => {
    const createdAt = new Date("2026-08-03T10:00:00Z");
    seed([
      row({
        createdAt,
        reviewedAt: new Date(createdAt.getTime() + 900), // under the floor
      }),
    ]);

    const { patterns, funnel } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns[0].rubberStamped).toBe(1);
    expect(patterns[0].approvedByHuman).toBe(0);
    expect(funnel.humanDecided).toBe(0);
  });

  it("counts a rejection as counter-evidence, separately from approvals", async () => {
    seed([row(), row({ status: "rejected" })]);

    const { patterns } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns[0].approvedByHuman).toBe(1);
    expect(patterns[0].rejected).toBe(1);
  });

  it("ignores a run with no eventType instead of inventing one", async () => {
    // cron / manual / webhook runs are real but carry no WHEN, so they can never
    // form a pattern. They must fall out at the funnel, not become a bucket
    // keyed on undefined.
    seed([row({ triggerPayload: { type: "cron" } }), row()]);

    const { patterns, funnel } = await scanApprovalPatterns({ userId: "u1" });

    expect(funnel.producedByAutomation).toBe(2);
    expect(funnel.withEventType).toBe(1);
    expect(patterns).toHaveLength(1);
  });

  it("distinguishes 'nothing repeated' from 'nothing is automation-produced'", async () => {
    // THE funnel property. With an inner join, both cases return zero patterns;
    // only `decidedTotal` vs `producedByAutomation` tells them apart. This is
    // the live situation today — a full approval log, almost none of it
    // automation-produced — and without these two numbers it reads as "no
    // pattern qualified", which would send someone tuning thresholds that are
    // not the problem.
    seed([], 100);

    const { patterns, funnel } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns).toHaveLength(0);
    expect(funnel.decidedTotal).toBe(100);
    expect(funnel.producedByAutomation).toBe(0);
  });

  it("ranks the strongest evidence first", async () => {
    seed([
      row({ triggerPayload: { eventType: "weak.event" } }),
      row({ triggerPayload: { eventType: "strong.event" } }),
      row({ triggerPayload: { eventType: "strong.event" } }),
    ]);

    const { patterns } = await scanApprovalPatterns({ userId: "u1" });

    expect(patterns[0].eventType).toBe("strong.event");
    expect(patterns[0].approvedByHuman).toBe(2);
  });
});
