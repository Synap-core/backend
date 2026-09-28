/**
 * The needs-you shaping rule (`groupNeedsYou`) — W2 "calm". Ported from the
 * browser's and relay's copies when the rule moved here (one leaf, two
 * surfaces).
 *
 * Every fixture row is chosen to RULE OUT a wrong rule, not to look
 * representative:
 * - a session whose key reappears after another row → rules out "merge all
 *   rows of a session" (a client re-sort that moves a server-placed row);
 * - an older row the server placed between recent ones → rules out sorting
 *   the Older bucket by anything but server order;
 * - a newest notification above an older cluster → rules out any kind hoist;
 * - an order that is neither alphabetical nor by id → rules out a re-sort by
 *   any key the rows carry.
 */
import { describe, expect, it } from "vitest";
import {
  capNeedsYouGroups,
  groupNeedsYou,
  groupSessionGoal,
  repeatLabel,
  sessionIdOfGroupKey,
  type GroupableSignal,
} from "./index";

function row(id: string, p: Partial<GroupableSignal> = {}): GroupableSignal {
  return {
    id,
    kind: "owed-slot",
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    ...p,
  };
}

const ids = (g: { items: GroupableSignal[] }[]) =>
  g.map((x) => x.items.map((i) => i.id));

describe("groupNeedsYou", () => {
  it("keeps server order across kinds — no hoist of clusters or owed slots", () => {
    const out = groupNeedsYou([
      row("notif-newest", { kind: "notification" }),
      row("cluster", {
        kind: "proposal-cluster",
        groupKey: "proposal-cluster:k1",
      }),
      row("slot", { groupKey: "session:s1" }),
    ]);
    expect(ids(out.recent)).toEqual([["notif-newest"], ["cluster"], ["slot"]]);
  });

  it("keeps a non-alphabetical pod order and groups a contiguous session run", () => {
    const out = groupNeedsYou([
      row("n9", { kind: "notification" }),
      row("a2", { groupKey: "session:A" }),
      row("a1", { groupKey: "session:A" }),
      row("c1", {
        kind: "proposal-cluster",
        groupKey: "proposal-cluster:k",
        count: 4,
      }),
    ]);
    expect(ids(out.recent)).toEqual([["n9"], ["a2", "a1"], ["c1"]]);
  });

  it("folds a contiguous run of one session under ONE header", () => {
    const out = groupNeedsYou([
      row("a1", { groupKey: "session:A", sessionGoal: "Market research" }),
      row("a2", { groupKey: "session:A" }),
      row("x"),
    ]);
    expect(ids(out.recent)).toEqual([["a1", "a2"], ["x"]]);
    expect(out.recent[0]?.sessionId).toBe("A");
    expect(out.recent[1]?.sessionId).toBeNull();
    expect(groupSessionGoal(out.recent[0]!)).toBe("Market research");
  });

  it("never merges a session key that reappears after another row (no client re-sort)", () => {
    const out = groupNeedsYou([
      row("a1", { groupKey: "session:A" }),
      row("b1", { groupKey: "session:B" }),
      row("a2", { groupKey: "session:A" }),
    ]);
    expect(ids(out.recent)).toEqual([["a1"], ["b1"], ["a2"]]);
    const keys = out.recent.map((g) => g.key);
    expect(new Set(keys).size, "react keys stay unique").toBe(3);
  });

  it("does not group proposal-cluster keys under a session header", () => {
    const out = groupNeedsYou([
      row("c1", { kind: "proposal-cluster", groupKey: "proposal-cluster:k" }),
      row("c2", { kind: "proposal-cluster", groupKey: "proposal-cluster:k" }),
    ]);
    expect(out.recent.every((g) => g.sessionId === null)).toBe(true);
    expect(ids(out.recent)).toEqual([["c1"], ["c2"]]);
  });

  it("splits older rows into the fold as a STABLE partition, counting rows", () => {
    const out = groupNeedsYou([
      row("r1"),
      row("o1", { ageBucket: "older", groupKey: "session:Z" }),
      row("r2"),
      row("o2", { ageBucket: "older", groupKey: "session:Z" }),
      row("o3", { ageBucket: "older" }),
    ]);
    expect(ids(out.recent)).toEqual([["r1"], ["r2"]]);
    expect(ids(out.older)).toEqual([["o1", "o2"], ["o3"]]);
    expect(out.olderCount).toBe(3);
  });

  it("reads a pre-W2 pod (fields absent on the wire) as recent singletons, not a failure", () => {
    // A client ships ahead of the pod it talks to; the type says what a W2 pod
    // sends, this row is what an older one actually sends.
    const legacy = { id: "legacy", kind: "notification" } as GroupableSignal;
    const out = groupNeedsYou([legacy]);
    expect(ids(out.recent)).toEqual([["legacy"]]);
    expect(out.olderCount).toBe(0);
    expect(repeatLabel(legacy)).toBeNull();
  });
});

describe("capNeedsYouGroups", () => {
  it("caps by GROUPS and never splits a session across the fold", () => {
    const { recent } = groupNeedsYou([
      row("a1", { groupKey: "session:A" }),
      row("a2", { groupKey: "session:A" }),
      row("a3", { groupKey: "session:A" }),
      row("x"),
      row("y"),
    ]);
    const { shown, hiddenRows } = capNeedsYouGroups(recent, 2);
    expect(ids(shown)).toEqual([["a1", "a2", "a3"], ["x"]]);
    expect(hiddenRows).toBe(1);
  });
});

describe("repeatLabel", () => {
  it("draws ×N = max(count, repeatCount), nothing at 1", () => {
    expect(repeatLabel({ count: 1, repeatCount: 4 })).toBe("×4");
    expect(repeatLabel({ count: 3, repeatCount: 1 })).toBe("×3");
    expect(repeatLabel({ count: 1, repeatCount: 1 })).toBeNull();
    expect(repeatLabel({})).toBeNull();
  });
});

describe("groupSessionGoal", () => {
  it("names the session goal of the first item that has one, trimmed", () => {
    const { recent } = groupNeedsYou([
      row("a1", { groupKey: "session:A" }),
      row("a2", { groupKey: "session:A", sessionGoal: " Ship billing " }),
    ]);
    expect(groupSessionGoal(recent[0]!)).toBe("Ship billing");
  });
});

describe("sessionIdOfGroupKey", () => {
  it("reads only session keys", () => {
    expect(sessionIdOfGroupKey("session:abc")).toBe("abc");
    expect(sessionIdOfGroupKey("session:")).toBeNull();
    expect(sessionIdOfGroupKey("proposal-cluster:abc")).toBeNull();
    expect(sessionIdOfGroupKey(null)).toBeNull();
  });
});
