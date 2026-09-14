/**
 * The blended usage rank — founder decision D3 (2026-09-14): ONE rank from
 * entity count + recency + what the human opens, the same for agents and
 * humans. These fixtures are chosen where the candidate rules DISAGREE, so each
 * row rules one out:
 *
 *   "busy but stale"  (500 entities, untouched for a year)
 *   "small but fresh" (3 entities, written today)
 *   "opened"          (1 entity, stale, but the human opened it 20× this week)
 *
 * A count-only rule ranks busy > fresh > opened. A recency-only rule ranks
 * fresh first. Only the blend puts "opened" first and still keeps volume
 * meaningful when everything is stale. The weights are a named default in
 * `USAGE_WEIGHTS`; this file pins the ORDER they produce, not the numbers.
 *
 * Pure: `rankByUsage` / `usageScore` / the folds never touch a database.
 */

import { describe, it, expect } from "vitest";
import {
  rankByUsage,
  usageByProfile,
  usageByWorkspace,
  usageScore,
  type EntityUsageRow,
  type UsageTotals,
} from "./usage-aggregate.js";
import { groupRankedProfiles } from "./profile-ranking.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const totals = (over: Partial<UsageTotals>): UsageTotals => ({
  count: 0,
  lastActivityAt: null,
  openCount: 0,
  lastOpenedAt: null,
  pinnedCount: 0,
  ...over,
});

const PROFILES = [
  { id: "busy", name: "Busy stale" },
  { id: "fresh", name: "Fresh small" },
  { id: "opened", name: "Opened" },
  { id: "unused-b", name: "Beta unused" },
  { id: "unused-a", name: "Alpha unused" },
];

const USAGE = new Map<string, UsageTotals>([
  ["busy", totals({ count: 500, lastActivityAt: daysAgo(365) })],
  ["fresh", totals({ count: 3, lastActivityAt: daysAgo(0) })],
  [
    "opened",
    totals({
      count: 1,
      lastActivityAt: daysAgo(365),
      openCount: 20,
      lastOpenedAt: daysAgo(1),
    }),
  ],
]);

const rank = (usage = USAGE) =>
  rankByUsage(PROFILES, {
    idOf: (p) => p.id,
    nameOf: (p) => p.name,
    usage,
    now: NOW,
  });

describe("rankByUsage — the blend, on fixtures where the rules disagree", () => {
  it("orders opened > busy-but-stale > small-but-fresh > unused (by name)", () => {
    expect(rank().map((r) => r.item.id)).toEqual([
      "opened",
      "busy",
      "fresh",
      "unused-a",
      "unused-b",
    ]);
  });

  it("assigns every row a dense 1-based rank — unused rows are ranked, not dropped", () => {
    expect(rank().map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("recency breaks a near-tie in volume", () => {
    const tie = new Map<string, UsageTotals>([
      ["busy", totals({ count: 10, lastActivityAt: daysAgo(200) })],
      ["fresh", totals({ count: 9, lastActivityAt: daysAgo(1) })],
    ]);
    const order = rank(tie).map((r) => r.item.id);
    expect(order.indexOf("fresh")).toBeLessThan(order.indexOf("busy"));
  });

  it("a pin counts even with no opens", () => {
    const pinned = new Map<string, UsageTotals>([
      ["busy", totals({ count: 2, lastActivityAt: daysAgo(90) })],
      [
        "fresh",
        totals({ count: 2, lastActivityAt: daysAgo(90), pinnedCount: 1 }),
      ],
    ]);
    const order = rank(pinned).map((r) => r.item.id);
    expect(order.indexOf("fresh")).toBeLessThan(order.indexOf("busy"));
  });

  it("scores absent usage as exactly 0 (no invented activity)", () => {
    expect(usageScore(undefined, NOW)).toBe(0);
    expect(usageScore(totals({}), NOW)).toBe(0);
  });
});

describe("the folds over aggregate rows", () => {
  const row = (over: Partial<EntityUsageRow>): EntityUsageRow => ({
    workspaceId: null,
    profileId: null,
    type: null,
    count: 0,
    lastActivityAt: null,
    openCount: 0,
    lastOpenedAt: null,
    pinnedCount: 0,
    ...over,
  });
  const rows = [
    row({
      workspaceId: "w1",
      profileId: "p1",
      count: 4,
      lastActivityAt: daysAgo(3),
    }),
    row({
      workspaceId: "w2",
      profileId: "p1",
      count: 6,
      lastActivityAt: daysAgo(1),
    }),
    row({ workspaceId: null, profileId: "p1", count: 5, openCount: 2 }),
    row({ workspaceId: "w1", profileId: "p2", count: 1 }),
  ];

  it("per profile sums every workspace AND the pod-scoped bucket, newest wins", () => {
    const p1 = usageByProfile(rows).get("p1")!;
    expect(p1.count).toBe(15);
    expect(p1.openCount).toBe(2);
    expect(p1.lastActivityAt).toEqual(daysAgo(1));
  });

  it("per workspace never treats the pod-scoped bucket as a workspace", () => {
    const byWs = usageByWorkspace(rows);
    expect([...byWs.keys()].sort()).toEqual(["w1", "w2"]);
    expect(byWs.get("w1")!.count).toBe(5);
  });
});

describe("groupRankedProfiles", () => {
  it("leads with `used` in rank order, then one group per origin; references ids only", () => {
    const ranked = [
      {
        profile: { id: "a", slug: "a" },
        rank: 1,
        score: 5,
        entityCount: 3,
        lastActivityAt: null,
        origin: {
          origin: "unknown" as const,
          group: "workspace" as const,
          workspaceId: "w1",
        },
      },
      {
        profile: { id: "b", slug: "b" },
        rank: 2,
        score: 1,
        entityCount: 1,
        lastActivityAt: null,
        origin: { origin: "core" as const, group: "core" as const },
      },
      {
        profile: { id: "c", slug: "c" },
        rank: 3,
        score: 0,
        entityCount: 0,
        lastActivityAt: null,
        origin: { origin: "unknown" as const, group: "unknown" as const },
      },
    ];
    const groups = groupRankedProfiles(ranked, (id) =>
      id === "w1" ? "CRM" : undefined
    );
    expect(groups.map((g) => g.key)).toEqual([
      "used",
      "core",
      "workspace:w1",
      "unknown",
    ]);
    expect(groups[0]!.profileIds).toEqual(["a", "b"]);
    expect(groups.find((g) => g.key === "workspace:w1")!.label).toBe("CRM");
  });
});
