/**
 * TRIPWIRE — one number, one source, for THE needs-you rule (decision E).
 *
 * The badge (`countNeedsYou`) and the list (`unionNeedsYou`, shaped by the
 * shared `needsYouRows`) read the SAME class per row (`owedSlotClassOf`, the
 * cluster's `needsYouClass`). This pins that they cannot diverge, fold by
 * fold: the headline count equals the headline rows, every fold count equals
 * the rows in that fold, and nothing is dropped (rows = headline + folds).
 *
 * Negative control: classing in the count by any other rule than the list's
 * (e.g. the pre-rule `isAskReviewLater` alone) turns these red — the
 * stamped `stopped` / `working` / `from_system` asks would sit in the
 * headline count while their rows sit in folds.
 *
 * NO DATABASE: both are pure over the rows the router fetches.
 */
import { describe, expect, it } from "vitest";
import { needsYouRows, type NeedsYouRow } from "@synap-core/types/needs-you";
import type { NeedsYouClass } from "@synap-core/types/needs-you/rule";
import {
  countNeedsYou,
  unionNeedsYou,
  type OwedSlotSignalInput,
  type Signal,
} from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function owed(
  sessionId: string,
  label: string,
  needsYouClass?: OwedSlotSignalInput["needsYouClass"],
  ageMs = DAY
): OwedSlotSignalInput {
  return {
    sessionId,
    label,
    owedSince: ago(ageMs).toISOString(),
    blockedReason: "decision",
    ...(needsYouClass ? { needsYouClass } : {}),
  };
}

function cluster(
  fp: string,
  needsYouClass: NeedsYouClass,
  ageMs = DAY
): ProposalCluster {
  return {
    fingerprint: fp,
    proposalType: "update",
    targetType: "entity",
    targetLabel: `Thing ${fp}`,
    count: 1,
    latestAt: ago(ageMs),
    sampleProposalIds: [`p-${fp}`],
    class: "objectWork",
    lifetimeHours: null,
    reviewLater: needsYouClass !== "needs_you",
    needsYouClass,
  } as unknown as ProposalCluster;
}

const OWED: OwedSlotSignalInput[] = [
  owed("live-1", "Pick the OS", "needs_you"),
  owed("live-2", "Approve the skill", "needs_you"),
  owed("busy", "Cancel the duplicate", "working"),
  owed("dead", "Decision 1", "stopped", 12 * DAY),
  owed("dead", "Decision 2", "stopped", 12 * DAY),
  owed("dead-2", "Mint the token", "stopped", 40 * DAY),
  owed("machine", "Check: 8 comparables", "from_system"),
  owed("old", "Founder validates the plan", "review_later", 9 * DAY),
  // An older read stamped no class: the legacy clock decides, both sides.
  owed("legacy", "Unclassed fresh"),
  owed("legacy-2", "Unclassed old", undefined, 9 * DAY),
];

const CLUSTERS: ProposalCluster[] = [
  cluster("deploy", "needs_you"),
  cluster("skill-1", "changes_to_review", 3 * DAY),
  cluster("skill-2", "changes_to_review", 10 * DAY),
  cluster("waited-old", "review_later", 9 * DAY),
];

const items = (rows: NeedsYouRow<Signal>[]) =>
  rows.flatMap((r) => (r.kind === "item" ? [r.signal] : r.items));

describe("needs-you folds: the count IS the rows (decision E)", () => {
  const signals = unionNeedsYou({
    clusters: CLUSTERS,
    notifications: [],
    owedSlots: OWED,
    now: NOW,
  });
  const count = countNeedsYou({
    distinctClusters: CLUSTERS.length,
    reviewLaterClusters: CLUSTERS.filter((c) => c.reviewLater).length,
    clusterFolds: {
      reviewLater: CLUSTERS.filter((c) => c.needsYouClass === "review_later")
        .length,
      changesToReview: CLUSTERS.filter(
        (c) => c.needsYouClass === "changes_to_review"
      ).length,
    },
    clustersTruncated: false,
    notifications: [],
    clusters: CLUSTERS,
    notificationsTruncated: false,
    owedSlots: OWED,
    owedTruncated: false,
    now: NOW,
  });
  const rows = needsYouRows(signals);

  it("NON-VACUITY: every slot and cluster became a row, and every fold is reached", () => {
    expect(signals).toHaveLength(OWED.length + CLUSTERS.length);
    for (const f of [
      "working",
      "stopped",
      "review_later",
      "from_system",
      "changes_to_review",
    ] as const) {
      expect(items(rows.folds[f]).length).toBeGreaterThan(0);
    }
  });

  it("the headline count equals the headline rows", () => {
    const headline = [...items(rows.recent), ...items(rows.older)];
    expect(headline.map((s) => s.title).sort()).toEqual(
      [
        "Pick the OS",
        "Approve the skill",
        "Unclassed fresh",
        // The deploy approval cluster's title, from the vocabulary.
        signals.find((s) => s.id === "cluster:deploy")!.title,
      ].sort()
    );
    expect(count.blocked + count.decisions).toBe(headline.length);
    expect(count.folds.needsYou).toBe(headline.length);
    expect(count.needsYou).toBe(headline.length);
  });

  it("each fold count equals the rows in that fold", () => {
    expect(count.folds.working).toBe(items(rows.folds.working).length);
    expect(count.folds.stopped).toBe(items(rows.folds.stopped).length);
    // Stopped draws ONE row per session.
    expect(count.folds.stoppedSessions).toBe(rows.folds.stopped.length);
    expect(count.folds.stoppedSessions).toBe(2);
    expect(count.folds.reviewLater).toBe(items(rows.folds.review_later).length);
    expect(count.folds.fromSystem).toBe(items(rows.folds.from_system).length);
    expect(count.folds.changesToReview).toBe(
      items(rows.folds.changes_to_review).length
    );
  });

  it("nothing is dropped: rows = headline + every out-of-headline fold", () => {
    expect(count.reviewLater).toBe(items(rows.reviewLater).length);
    expect(count.folds.needsYou + count.reviewLater).toBe(signals.length);
  });
});
