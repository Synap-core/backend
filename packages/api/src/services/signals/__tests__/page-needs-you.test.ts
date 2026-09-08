/**
 * `pageNeedsYou` — neither source may evict the other from the tray page.
 *
 * THE BUG. `unionNeedsYou` concatenates owed slots FIRST (settled: an owed slot
 * never expires, so age is severity) and `signals.list` then took a single
 * `slice(0, limit)` across the whole thing. One cap, shared between an
 * UNBOUNDED never-decaying source and a bounded decaying one: at 37 live owed
 * slots against a limit of 50 the tray was already all owed slots, and past 50
 * the pending-proposal queue became unreachable from the tray while the badge
 * went on counting it.
 *
 * Every test here drives the REAL union so the page is applied to the real
 * ordering — a hand-built array would let the ordering and the paging drift.
 */
import { describe, it, expect } from "vitest";
import {
  unionNeedsYou,
  pageNeedsYou,
  RESERVED_DECISION_ROWS,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
} from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

function owedSlots(n: number): OwedSlotSignalInput[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `session-${i}`,
    label: `Owed ${i}`,
    // Ascending dates, so slot 0 is the OLDEST and must never be paged out.
    owedSince: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  }));
}

function clusters(n: number): ProposalCluster[] {
  return Array.from({ length: n }, (_, i) => ({
    fingerprint: `fp-${i}`,
    proposalType: "entity.create",
    targetType: "entity",
    targetLabel: `Thing ${i}`,
    count: 1,
    latestAt: new Date(Date.UTC(2026, 5, 1 + i)),
    sampleProposalIds: [`p-${i}`],
    class: "objectWork",
    lifetimeHours: null,
  })) as unknown as ProposalCluster[];
}

const NO_NOTIFS: NotificationSignalInput[] = [];

const page = (owed: number, decisions: number, limit = 50) =>
  pageNeedsYou(
    unionNeedsYou({
      clusters: clusters(decisions),
      notifications: NO_NOTIFS,
      owedSlots: owedSlots(owed),
    }),
    limit
  );

describe("pageNeedsYou", () => {
  it("today's live shape: 37 owed slots do not fill the page alone", () => {
    // The measured production state that motivated the fix.
    const rows = page(37, 100);
    expect(rows).toHaveLength(50);
    expect(rows.filter((s) => s.kind === "owed-slot")).toHaveLength(37);
    expect(rows.filter((s) => s.kind === "proposal-cluster")).toHaveLength(13);
  });

  it("PAST the cap, decisions are still reachable — the starvation itself", () => {
    const rows = page(200, 100);
    expect(rows).toHaveLength(50);
    const decisions = rows.filter((s) => s.kind === "proposal-cluster");
    expect(decisions.length).toBe(RESERVED_DECISION_ROWS);
    // …and owed slots still lead the page.
    expect(rows[0]?.kind).toBe("owed-slot");
  });

  it("the reserve is a FLOOR, not an allocation — few decisions waste no rows", () => {
    const rows = page(100, 3);
    expect(rows).toHaveLength(50);
    expect(rows.filter((s) => s.kind === "owed-slot")).toHaveLength(47);
    expect(rows.filter((s) => s.kind === "proposal-cluster")).toHaveLength(3);
  });

  it("with no decisions at all the page is entirely owed slots", () => {
    const rows = page(100, 0);
    expect(rows).toHaveLength(50);
    expect(rows.every((s) => s.kind === "owed-slot")).toBe(true);
  });

  it("with no owed slots the page is entirely decisions", () => {
    const rows = page(0, 100);
    expect(rows).toHaveLength(50);
    expect(rows.every((s) => s.kind === "proposal-cluster")).toBe(true);
  });

  it("keeps the settled ordering: owed first, and the OLDEST owed survives", () => {
    const rows = page(200, 100);
    const firstOwed = rows.findIndex((s) => s.kind === "owed-slot");
    const firstOther = rows.findIndex((s) => s.kind !== "owed-slot");
    expect(firstOwed).toBe(0);
    expect(firstOther).toBeGreaterThan(0);
    // Oldest-first inside the owed group — the row the feature exists to surface.
    expect(rows[0]?.title).toBe("Owed 0");
  });

  it("a page too small for the reserve does not INVERT the ordering", () => {
    // The reserve is capped at half the page, so `limit: 1` still shows the
    // oldest blocker rather than handing the only row to a proposal.
    const rows = page(5, 5, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("owed-slot");
    expect(rows[0]?.title).toBe("Owed 0");
  });

  it("never returns more than the limit, over the whole cross-product", () => {
    for (const owed of [0, 1, 9, 37, 50, 200]) {
      for (const decisions of [0, 1, 9, 50, 100]) {
        for (const limit of [1, 2, 7, 50, 100]) {
          const rows = page(owed, decisions, limit);
          expect(rows.length).toBeLessThanOrEqual(limit);
          // And it never leaves the page short while rows remain unshown.
          const available = Math.min(owed + decisions, limit);
          expect(rows.length).toBe(available);
        }
      }
    }
  });
});
