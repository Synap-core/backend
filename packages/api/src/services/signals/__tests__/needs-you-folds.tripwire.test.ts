/**
 * TRIPWIRE — one number, one source, for THE needs-you rule (decision E).
 *
 * The badge (`countNeedsYou`) and the list (`unionNeedsYou`, shaped by the
 * shared `needsYouRows`) read the SAME class per row (`owedSlotClassOf`, the
 * cluster's `needsYouClass`). This pins that they cannot diverge, fold by
 * fold: the headline count equals the headline rows, every fold count equals
 * the rows in that fold, and nothing is dropped (rows = headline + folds).
 * ONE headline number (M5): `count.needsYou` and `count.folds.needsYou` are
 * the same, with a notification and a review session in the headline too.
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
  type NotificationSignalInput,
  type OwedSlotSignalInput,
  type Signal,
} from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";
import { clusterFoldCounts } from "../../proposals/proposal-needs-you.js";

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
  // F2: a wait on a session an agent is working.
  cluster("waited-busy", "working"),
];

// The headline's other populations: an unread item and a session awaiting
// review. A count that leaves either out of `folds.needsYou` says two numbers.
const NOTIFICATIONS: NotificationSignalInput[] = [
  {
    id: "n-sync",
    title: "Sync failed",
    category: "system",
    sourceType: "connector",
    sourceId: "conn-1",
    createdAt: ago(DAY),
  },
];
const REVIEW = [
  {
    id: "rev-1",
    title: "Ship the page",
    goal: "Ship the page",
    updatedAt: ago(DAY),
  },
];

// D-R1: a session whose agent waits on the person's permission dialog. A
// count that adds it another way than the list's rows says two numbers.
const PERMISSION = [
  {
    id: "perm-1",
    title: "Run the migration",
    goal: "Run the migration",
    since: ago(DAY / 24),
  },
];

const items = (rows: NeedsYouRow<Signal>[]) =>
  rows.flatMap((r) => (r.kind === "item" ? [r.signal] : r.items));

describe("needs-you folds: the count IS the rows (decision E)", () => {
  const signals = unionNeedsYou({
    clusters: CLUSTERS,
    notifications: NOTIFICATIONS,
    owedSlots: OWED,
    reviewSessions: REVIEW,
    permissionSessions: PERMISSION,
    now: NOW,
  });
  const count = countNeedsYou({
    distinctClusters: CLUSTERS.length,
    reviewLaterClusters: CLUSTERS.filter((c) => c.reviewLater).length,
    clusterFolds: clusterFoldCounts(CLUSTERS),
    clustersTruncated: false,
    notifications: NOTIFICATIONS,
    clusters: CLUSTERS,
    notificationsTruncated: false,
    owedSlots: OWED,
    owedTruncated: false,
    reviewSessions: REVIEW.length,
    reviewSessionIds: REVIEW.map((r) => r.id),
    permissionSessions: PERMISSION,
    now: NOW,
  });
  const rows = needsYouRows(signals);

  it("NON-VACUITY: every slot and cluster became a row, and every fold is reached", () => {
    expect(signals).toHaveLength(
      OWED.length +
        CLUSTERS.length +
        NOTIFICATIONS.length +
        REVIEW.length +
        PERMISSION.length
    );
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
        "Sync failed",
        // The deploy approval cluster's and the review row's titles.
        signals.find((s) => s.id === "cluster:deploy")!.title,
        signals.find((s) => s.kind === "session-review")!.title,
        "Run the migration",
      ].sort()
    );
    // The notification, the review and the permission are headline rows too.
    expect(count.blocked + count.decisions).toBe(headline.length - 3);
    // D-R1: one item per session waiting on a permission, in the headline.
    expect(count.permission).toBe(1);
    expect(signals.find((s) => s.kind === "session-permission")).toMatchObject({
      target: { kind: "session", id: "perm-1" },
      why: "Waiting for your permission",
      groupKey: "session:perm-1",
    });
    // ONE headline number: the folds state the same one (M5).
    expect(count.needsYou).toBe(headline.length);
    expect(count.folds.needsYou).toBe(count.needsYou);
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

describe("the asking events the rule excludes from Working name the real event", () => {
  it("NEEDS_YOU_ASKING_EVENT_TYPES holds the slot_asked event type the ask doors log", async () => {
    const { NEEDS_YOU_ASKING_EVENT_TYPES } =
      await import("@synap-core/types/needs-you/rule");
    const { FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE } =
      await import("../../focus-sessions/lifecycle-events.js");
    expect(NEEDS_YOU_ASKING_EVENT_TYPES).toContain(
      FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE
    );
  });
});
