/**
 * The 6-hourly expiry pass also expires stage gates whose session had ALREADY
 * ended (`expireOrphanedStageGates`, @synap/database). Live, 16 Nov 2026:
 * gate 491def0c stayed pending on session 432f5ac2, closed on 9 Nov, and three
 * such gates failed when they were approved. The helper's own behaviour (which
 * gates, stamped why) is pinned on a real Postgres in
 * `work-unit-transitions.pglite.test.ts`; this pins that the pass CALLS it,
 * counts what it expired, and takes those rows out of the bell.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const markActioned = vi.fn();
vi.mock("../../notifications/mark-proposal-notifications-actioned.js", () => ({
  markProposalNotificationsActioned: (...a: unknown[]) => markActioned(...a),
}));

const expireOrphanedStageGates = vi.fn();
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    expireOrphanedStageGates: (...a: unknown[]) =>
      expireOrphanedStageGates(...a),
    // Nothing else is pending: only the orphaned-gate sweep has work.
    db: {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }),
    },
  };
});

import { expireLapsedProposals } from "./expire-lapsed-proposals.js";

describe("expireLapsedProposals expires the stage gates of ended sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts them and takes them out of the bell", async () => {
    expireOrphanedStageGates.mockResolvedValue(["gate-1", "gate-2"]);
    const res = await expireLapsedProposals(new Date("2026-11-16T12:00:00Z"));
    expect(expireOrphanedStageGates).toHaveBeenCalledTimes(1);
    expect(res.expired).toBe(2);
    expect(markActioned).toHaveBeenCalledWith(["gate-1", "gate-2"]);
  });

  it("a failed sweep is logged, never fatal to the pass", async () => {
    expireOrphanedStageGates.mockRejectedValue(new Error("boom"));
    const res = await expireLapsedProposals(new Date("2026-11-16T12:00:00Z"));
    expect(res.expired).toBe(0);
  });
});
