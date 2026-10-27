/**
 * TRIPWIRE — an owed ask nobody answered for 7 days leaves the headline, and
 * the COUNT and the FOLD say so together (founder, 2026-10-26).
 *
 * The pair that must agree: `countNeedsYou` (the badge, orient's mirror) and
 * the rows `unionNeedsYou` stamps `reviewLater` (the list's fold). Both read
 * `isAskReviewLater`; this pins that they cannot diverge — a count that drops
 * the old ask while its row still sits in Recent (or the reverse) is the
 * "one number, two sources" defect.
 *
 * Also the seam the cards read: the asker's NAME and the cause reach the
 * owed-slot signal (`by`, `askCause`) — projected, not merely declared.
 *
 * NO DATABASE: both are pure over the rows the router fetches.
 */
import { describe, expect, it } from "vitest";
import { needsYouRows } from "@synap-core/types/needs-you";
import { REVIEW_LATER_AFTER_DAYS } from "@synap-core/types/proposals/fate";
import {
  countNeedsYou,
  signalFromOwedSlot,
  unionNeedsYou,
  type OwedSlotSignalInput,
} from "./needs-you-union.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

function owed(
  label: string,
  ageDays: number | null,
  over: Partial<OwedSlotSignalInput> = {}
): OwedSlotSignalInput {
  return {
    sessionId: `s-${label}`,
    label,
    owedSince: ageDays === null ? "0000-00-00" : daysAgo(ageDays),
    blockedReason: "decision",
    ...over,
  };
}

const SLOTS = [
  owed("fresh", 1),
  owed("edge", REVIEW_LATER_AFTER_DAYS - 0.5),
  owed("old", REVIEW_LATER_AFTER_DAYS + 1),
  owed("ancient", 40),
  // Unreadable stamp: fails toward the headline, never quietly folded away.
  owed("unstamped", null),
];

describe("owed asks in Review later: the count and the fold agree", () => {
  const signals = unionNeedsYou({
    clusters: [],
    notifications: [],
    owedSlots: SLOTS,
    now: NOW,
  });
  const count = countNeedsYou({
    distinctClusters: 0,
    clustersTruncated: false,
    notifications: [],
    clusters: [],
    notificationsTruncated: false,
    owedSlots: SLOTS,
    owedTruncated: false,
    now: NOW,
  });

  it("NON-VACUITY: every owed slot became a row", () => {
    expect(signals.filter((s) => s.kind === "owed-slot")).toHaveLength(
      SLOTS.length
    );
  });

  it("exactly the >7-day asks are marked reviewLater", () => {
    expect(
      signals
        .filter((s) => s.reviewLater)
        .map((s) => s.title)
        .sort()
    ).toEqual(["ancient", "old"]);
  });

  it("the count leaves them out of the headline and reports them", () => {
    const later = signals.filter((s) => s.reviewLater).length;
    expect(count.reviewLater).toBe(later);
    expect(count.blocked).toBe(SLOTS.length - later);
    expect(count.needsYou).toBe(SLOTS.length - later);
  });

  it("the list folds those same rows into Review later, none in Recent/Older", () => {
    const rows = needsYouRows(signals);
    const folded = rows.reviewLater.flatMap((r) =>
      r.kind === "item" ? [r.signal.title] : r.items.map((i) => i.title)
    );
    expect(folded.sort()).toEqual(["ancient", "old"]);
    const headline = [...rows.recent, ...rows.older].flatMap((r) =>
      r.kind === "item" ? [r.signal.title] : r.items.map((i) => i.title)
    );
    expect(headline.length).toBe(count.blocked);
  });
});

describe("a relay waiting for the tap is never folded away as old", () => {
  const relayed = owed("relayed", REVIEW_LATER_AFTER_DAYS + 5, {
    pendingRelay: {
      text: "Yes",
      relayedBy: "agent-1",
      quote: "yes ship it",
      relayedAt: daysAgo(0.1),
    },
  });
  it("the row and the count keep it in the headline", () => {
    const [row] = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [relayed],
      now: NOW,
    }).filter((s) => s.kind === "owed-slot");
    expect(row!.reviewLater).toBeUndefined();
    const count = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      notifications: [],
      clusters: [],
      notificationsTruncated: false,
      owedSlots: [relayed],
      owedTruncated: false,
      now: NOW,
    });
    expect(count.reviewLater).toBe(0);
    expect(count.needsYou).toBe(1);
  });
});

describe("the owed-slot signal carries who asked and why", () => {
  it("a named asker → `by`, the agent's door", () => {
    const s = signalFromOwedSlot(
      owed("a", 1, { askedBy: "agent-1", askedByName: "Claude Code" }),
      NOW
    );
    expect(s.by).toEqual({
      kind: "agent",
      id: "agent-1",
      label: "Claude Code",
    });
  });

  it("an asker the pod cannot name sends no `by` (never its id as a name)", () => {
    const s = signalFromOwedSlot(owed("a", 1, { askedBy: "agent-1" }), NOW);
    expect(s.by).toBeUndefined();
  });

  it("the cause rides as `askCause`", () => {
    const cause = {
      kind: "decision" as const,
      ref: { kind: "entity", id: "d-1" },
      at: "2026-09-29T10:00:00.000Z",
    };
    expect(
      signalFromOwedSlot(owed("a", 1, { askCause: cause }), NOW).askCause
    ).toEqual(cause);
  });
});
