/**
 * W2 "calm" — the ONE needs-you order, session blocks, notification folds,
 * the Older bucket, and the badge counting exactly the folded list.
 *
 * Every test drives the REAL union (`unionNeedsYou` / `countNeedsYou`) — a
 * hand-built array would let the ordering, the grouping and the count drift
 * apart, which is the defect this file exists to catch.
 */
import { describe, it, expect } from "vitest";
import {
  unionNeedsYou,
  countNeedsYou,
  foldNotifications,
  orderNeedsYou,
  signalFromCluster,
  signalFromNotification,
  signalFromOwedSlot,
  signalsFromDraftAsks,
  SIGNAL_UNIVERSAL_FIELDS,
  OLDER_AFTER_MS,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
  type Signal,
} from "../needs-you-union.js";
import type { ProposalCluster } from "../../proposals/fingerprint.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const DAY = 24;

function cluster(fp: string, at: Date): ProposalCluster {
  return {
    fingerprint: fp,
    proposalType: "create",
    targetType: "entity",
    targetLabel: `Thing ${fp}`,
    count: 1,
    latestAt: at,
    sampleProposalIds: [`p-${fp}`],
    class: "objectWork",
    lifetimeHours: null,
  } as unknown as ProposalCluster;
}

function owed(sessionId: string, label: string, at: Date): OwedSlotSignalInput {
  return { sessionId, label, owedSince: at.toISOString() };
}

function notif(
  id: string,
  at: Date,
  over: Partial<NotificationSignalInput> = {}
): NotificationSignalInput {
  return {
    id,
    title: `Notification ${id}`,
    category: "ai",
    sourceType: "automation",
    sourceId: `auto-${id}`,
    type: "automation.notification",
    createdAt: at,
    ...over,
  };
}

const ids = (signals: Signal[]) => signals.map((s) => s.id);

describe("needs-you order — newest first across kinds", () => {
  // The ordering TABLE: each row is a pair the OLD rule (owed first, oldest
  // first) and the NEW rule order differently — a row both rules agree on
  // would rule nothing out.
  const table: Array<{
    name: string;
    args: Parameters<typeof unionNeedsYou>[0];
    expected: string[];
  }> = [
    {
      name: "a fresh decision outranks a 2-week-old owed slot",
      args: {
        clusters: [cluster("fresh", ago(1))],
        notifications: [],
        owedSlots: [owed("s-old", "Old slot", ago(14 * DAY))],
      },
      expected: ["cluster:fresh", "slot:s-old:old slot"],
    },
    {
      name: "a fresh notification outranks a 3-day-old owed slot",
      args: {
        clusters: [],
        notifications: [notif("n1", ago(2))],
        owedSlots: [owed("s-3d", "Three days", ago(3 * DAY))],
      },
      expected: ["notification:n1", "slot:s-3d:three days"],
    },
    {
      name: "the newer of two owed slots on different sessions comes first",
      args: {
        clusters: [],
        notifications: [],
        owedSlots: [
          owed("s-a", "Older", ago(5 * DAY)),
          owed("s-b", "Newer", ago(1 * DAY)),
        ],
      },
      expected: ["slot:s-b:newer", "slot:s-a:older"],
    },
    {
      name: "a fresh owed slot still outranks an older decision",
      args: {
        clusters: [cluster("old", ago(4 * DAY))],
        notifications: [],
        owedSlots: [owed("s-new", "Fresh", ago(1))],
      },
      expected: ["slot:s-new:fresh", "cluster:old"],
    },
  ];
  for (const row of table) {
    it(row.name, () => {
      expect(ids(unionNeedsYou({ ...row.args, now: NOW }))).toEqual(
        row.expected
      );
    });
  }
});

describe("session blocks are contiguous", () => {
  it("a session's rows sit together at its NEWEST row's position, newest first inside", () => {
    const signals = unionNeedsYou({
      clusters: [cluster("mid", ago(3))],
      notifications: [],
      owedSlots: [
        owed("s-1", "First", ago(1)),
        owed("s-1", "Second", ago(5)),
        owed("s-2", "Other", ago(4)),
      ],
      now: NOW,
    });
    // s-1's newest (1h) puts the whole block first, dragging its 5h slot
    // ahead of the 3h cluster and the 4h s-2 slot — contiguity over recency.
    expect(ids(signals)).toEqual([
      "slot:s-1:first",
      "slot:s-1:second",
      "cluster:mid",
      "slot:s-2:other",
    ]);
    expect(signals.map((s) => s.groupKey)).toEqual([
      "session:s-1",
      "session:s-1",
      "proposal-cluster:mid",
      "session:s-2",
    ]);
  });

  it("a session's draft-asks row carries the session key", () => {
    const [row] = signalsFromDraftAsks(
      {
        slots: [owed("d-1", "Pick", ago(2))],
        starterNames: new Map(),
      },
      NOW
    );
    expect(row!.groupKey).toBe("session:d-1");
  });

  it("every groupKey appears as ONE run in the list (derived over a busy fixture)", () => {
    const owedSlots: OwedSlotSignalInput[] = [];
    for (let s = 0; s < 6; s++)
      for (let k = 0; k < 3; k++)
        owedSlots.push(owed(`s-${s}`, `L${k}`, ago(s * 7 + k * 13)));
    const signals = unionNeedsYou({
      clusters: [cluster("a", ago(2)), cluster("b", ago(20))],
      notifications: [notif("n", ago(9))],
      owedSlots,
      now: NOW,
    });
    // Non-vacuity: the fixture really interleaves blocks by time.
    expect(signals.length).toBe(21);
    const seen = new Set<string>();
    let prev: string | null = null;
    for (const s of signals) {
      const key = `${s.ageBucket}|${s.groupKey ?? s.id}`;
      if (key !== prev) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      prev = key;
    }
  });
});

describe("notification folds", () => {
  it("the same (type, target) raised N times is ONE row with repeatCount N, carrying the newest", () => {
    const rows = [
      notif("old", ago(10), { sourceId: "auto-1" }),
      notif("new", ago(1), { sourceId: "auto-1" }),
      notif("mid", ago(5), { sourceId: "auto-1" }),
      notif("other", ago(2), { sourceId: "auto-2" }),
    ];
    const signals = unionNeedsYou({
      clusters: [],
      notifications: rows,
      owedSlots: [],
      now: NOW,
    });
    expect(ids(signals)).toEqual(["notification:new", "notification:other"]);
    expect(signals.map((s) => s.repeatCount)).toEqual([3, 1]);
  });

  it("a different type on the same target is NOT the same news", () => {
    const folded = foldNotifications([
      notif("a", ago(1), { sourceId: "x", type: "automation.notification" }),
      notif("b", ago(2), { sourceId: "x", type: "automation.broken" }),
    ]);
    expect(folded).toHaveLength(2);
  });

  it("targetless rows never fold together", () => {
    const folded = foldNotifications([
      notif("a", ago(1), { sourceId: null }),
      notif("b", ago(2), { sourceId: null }),
    ]);
    expect(folded.map((f) => f.repeatCount)).toEqual([1, 1]);
  });
});

describe("age bucket", () => {
  it("older than 7 days is `older`; the boundary itself is `recent`", () => {
    const at = (ms: number) =>
      signalFromOwedSlot(owed("s", "x", new Date(NOW.getTime() - ms)), NOW)
        .ageBucket;
    expect(at(OLDER_AFTER_MS)).toBe("recent");
    expect(at(OLDER_AFTER_MS + 1)).toBe("older");
    expect(at(0)).toBe("recent");
  });

  it("every recent row precedes every older row, whatever the kind", () => {
    const signals = unionNeedsYou({
      clusters: [cluster("old-decision", ago(9 * DAY))],
      notifications: [notif("n-old", ago(8 * DAY))],
      owedSlots: [
        owed("s-1", "Recent", ago(6 * DAY)),
        owed("s-1", "Ancient", ago(20 * DAY)),
      ],
      now: NOW,
    });
    expect(signals.map((s) => s.ageBucket)).toEqual([
      "recent",
      "older",
      "older",
      "older",
    ]);
    // s-1 straddles the boundary: its recent slot leads, its ancient slot is
    // in the Older block — the age rule outranks grouping.
    expect(signals[0]!.id).toBe("slot:s-1:recent");
    expect(signals.at(-1)!.id).toBe("slot:s-1:ancient");
  });
});

describe("count counts exactly the folded list", () => {
  it("count.needsYou === list length, over folds, drafts, pointers and dedupe", () => {
    const clusters = [cluster("c1", ago(1)), cluster("c2", ago(30 * DAY))];
    const notifications = [
      notif("r1", ago(1), { sourceId: "auto-1" }),
      notif("r2", ago(3), { sourceId: "auto-1" }),
      notif("r3", ago(4), { sourceId: "auto-1" }),
      notif("solo", ago(2), { sourceId: "auto-9" }),
      // dropped by the proposal dedupe
      notif("prop", ago(2), { sourceType: "proposal", sourceId: "p-c1" }),
    ];
    const owedSlots = [
      owed("s-1", "A", ago(2)),
      owed("s-1", "B", ago(9 * DAY)),
    ];
    const draftAsks = {
      slots: [owed("d-1", "Q1", ago(1)), owed("d-1", "Q2", ago(2))],
      starterNames: new Map<string, string>(),
    };
    const listed = unionNeedsYou({
      clusters,
      notifications,
      owedSlots,
      draftAsks,
      openQuestionSessionIds: new Set(),
      now: NOW,
    });
    const counted = countNeedsYou({
      distinctClusters: clusters.length,
      clustersTruncated: false,
      clusters,
      notifications,
      notificationsTruncated: false,
      owedSlots,
      owedTruncated: false,
      openQuestionSessionIds: new Set(),
      draftAsks,
    });
    // Non-vacuity: the fold really happened (3 rows became 1).
    expect(listed.find((s) => s.id === "notification:r1")?.repeatCount).toBe(3);
    expect(counted.notifications).toBe(2);
    expect(counted.needsYou).toBe(listed.length);
  });
});

describe("universal signal fields reach every producer", () => {
  it("every producer sets groupKey, ageBucket and repeatCount (derived from the classification)", () => {
    const produced: Signal[] = [
      signalFromCluster(cluster("c", ago(1)), NOW),
      signalFromNotification(notif("n", ago(1)), NOW),
      signalFromOwedSlot(owed("s", "x", ago(1)), NOW),
      ...signalsFromDraftAsks(
        { slots: [owed("d", "y", ago(1))], starterNames: new Map() },
        NOW
      ),
    ];
    // Non-vacuity: the classification names the three new fields.
    expect(SIGNAL_UNIVERSAL_FIELDS).toEqual(
      expect.arrayContaining(["groupKey", "ageBucket", "repeatCount"])
    );
    for (const s of produced)
      for (const f of SIGNAL_UNIVERSAL_FIELDS)
        expect(s, `${s.kind}.${String(f)}`).toHaveProperty(f);
  });

  it("orderNeedsYou is total: same input, any permutation, same output", () => {
    const base = unionNeedsYou({
      clusters: [cluster("a", ago(1)), cluster("b", ago(1))],
      notifications: [notif("n", ago(1))],
      owedSlots: [owed("s", "x", ago(1))],
      now: NOW,
    });
    expect(ids(orderNeedsYou([...base].reverse()))).toEqual(ids(base));
  });
});
