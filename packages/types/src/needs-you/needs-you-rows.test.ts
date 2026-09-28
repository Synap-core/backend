/**
 * `needsYouRows` — the ONE-LIST rule (founder, 2026-09-28): a session owing
 * ONE thing is that thing's row; a session owing TWO OR MORE is one card.
 *
 * Fixture rows are chosen to rule OUT a wrong rule:
 * - the singleton-vs-multi table: the SAME session drawn once with one item
 *   and once with two must flip item ↔ card (rules out "every session item is
 *   a card" and "never a card");
 * - a session whose key reappears after another row stays TWO rows (rules out
 *   a client merge that moves a server-placed row);
 * - the cap on a card + singles counts ROWS (rules out capping by signals,
 *   which would split or under-show a card);
 * - a title-less older pod row falls back to the goal's first line, and a
 *   stamped title beats the goal (rules out "always the goal" — the W2 pill
 *   the founder rejected);
 * - counts are by kind in first-appearance order, with a draft row counting
 *   its N asks (rules out "count rows" and "count by signal.kind").
 */
import { describe, expect, it } from "vitest";
import {
  capNeedsYouRows,
  needsYouCountsLabel,
  needsYouItemKind,
  needsYouRows,
  type GroupableSignal,
  type NeedsYouRow,
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

const shape = (rows: NeedsYouRow<GroupableSignal>[]) =>
  rows.map((r) =>
    r.kind === "item"
      ? `item:${r.signal.id}`
      : `session:${r.sessionId}[${r.items.map((i) => i.id).join(",")}]`
  );

describe("needsYouRows — singleton vs multi", () => {
  const S = { groupKey: "session:S", sessionTitle: "Tracks-first" };
  const table: Array<{
    name: string;
    signals: GroupableSignal[];
    want: string[];
  }> = [
    {
      name: "a session owing ONE thing is that thing's own row",
      signals: [row("s1", S), row("x")],
      want: ["item:s1", "item:x"],
    },
    {
      name: "a session owing TWO things is ONE card, where its newest sat",
      signals: [row("x"), row("s1", S), row("s2", S), row("y")],
      want: ["item:x", "session:S[s1,s2]", "item:y"],
    },
    {
      name: "a key that reappears after another row is never merged",
      signals: [row("s1", S), row("x"), row("s2", S)],
      want: ["item:s1", "item:x", "item:s2"],
    },
    {
      name: "cluster keys are never a session card",
      signals: [
        row("c1", { kind: "proposal-cluster", groupKey: "proposal-cluster:k" }),
        row("c2", { kind: "proposal-cluster", groupKey: "proposal-cluster:k" }),
      ],
      want: ["item:c1", "item:c2"],
    },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(shape(needsYouRows(t.signals).recent)).toEqual(t.want);
    });
  }

  it("a single item keeps its session as provenance (id, title, project)", () => {
    const [only] = needsYouRows([
      row("s1", { ...S, sessionProjectId: "p1" }),
    ]).recent;
    expect(only).toMatchObject({
      kind: "item",
      session: { id: "S", title: "Tracks-first", projectId: "p1" },
    });
  });

  it("an item outside any session carries no provenance", () => {
    const [only] = needsYouRows([row("n", { kind: "notification" })]).recent;
    expect(only).toMatchObject({ kind: "item", session: null });
  });
});

describe("needsYouRows — server order, older wires", () => {
  it("keeps server order across kinds — no hoist of clusters, slots or notifications", () => {
    const out = needsYouRows([
      row("notif-newest", { kind: "notification" }),
      row("cluster", { kind: "proposal-cluster", groupKey: "proposal-cluster:k1" }),
      row("slot", { groupKey: "session:s1" }),
    ]);
    expect(shape(out.recent)).toEqual(["item:notif-newest", "item:cluster", "item:slot"]);
  });

  it("react keys stay unique when a session key reappears", () => {
    const out = needsYouRows([
      row("a1", { groupKey: "session:A" }),
      row("a2", { groupKey: "session:A" }),
      row("b", { groupKey: "session:B" }),
      row("a3", { groupKey: "session:A" }),
      row("a4", { groupKey: "session:A" }),
    ]);
    const keys = out.recent.map((r) => r.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("reads a pre-W2 pod (fields absent on the wire) as recent items, not a failure", () => {
    const legacy = { id: "legacy", kind: "notification" } as GroupableSignal;
    const out = needsYouRows([legacy]);
    expect(shape(out.recent)).toEqual(["item:legacy"]);
    expect(out.olderCount).toBe(0);
  });
});

describe("needsYouRows — the card", () => {
  it("names the session by its TITLE, not its goal; project + newest carried", () => {
    const [card] = needsYouRows([
      row("a", {
        groupKey: "session:S",
        sessionGoal: "A long goal sentence that the W2 pill used to show",
        sessionTitle: "Tracks-first",
        sessionProjectId: "p1",
        occurredAt: "2026-09-28T10:00:00.000Z",
      }),
      row("b", {
        groupKey: "session:S",
        occurredAt: "2026-09-27T10:00:00.000Z",
      }),
    ]).recent;
    expect(card).toMatchObject({
      kind: "session",
      title: "Tracks-first",
      projectId: "p1",
      newestAt: "2026-09-28T10:00:00.000Z",
    });
  });

  it("an older pod (no sessionTitle) falls back to the goal's FIRST LINE", () => {
    const [card] = needsYouRows([
      row("a", { groupKey: "session:S", sessionGoal: "Ship billing\nand more" }),
      row("b", { groupKey: "session:S" }),
    ]).recent;
    expect(card).toMatchObject({ kind: "session", title: "Ship billing", projectId: null });
  });

  it("counts by kind, first-appearance order; a draft row counts its asks", () => {
    const [card] = needsYouRows([
      row("a", { groupKey: "session:S", blockedReason: "physical" }),
      row("b", { groupKey: "session:S", blockedReason: "decision" }),
      row("c", { groupKey: "session:S", blockedReason: "decision" }),
      row("d", { groupKey: "session:S", kind: "draft-asks", count: 3 }),
    ]).recent;
    if (card?.kind !== "session") throw new Error("expected a card");
    expect(card.counts).toEqual([
      { kind: "physical", count: 1 },
      { kind: "decision", count: 2 },
      { kind: "ask", count: 3 },
    ]);
    expect(needsYouCountsLabel(card.counts)).toBe(
      "1 action · 2 decisions · 3 asks"
    );
  });

  it("item kinds: reason, else owed; draft ask; review", () => {
    expect(needsYouItemKind(row("a"))).toBe("owed");
    expect(needsYouItemKind(row("a", { blockedReason: "Decision" }))).toBe("decision");
    expect(needsYouItemKind(row("a", { kind: "draft-asks" }))).toBe("ask");
    expect(needsYouItemKind(row("a", { kind: "session-review" }))).toBe("review");
    expect(needsYouItemKind(row("a", { kind: "proposal-cluster" }))).toBe("decision");
    expect(needsYouCountsLabel([{ kind: "decision", count: 1 }])).toBe("1 decision");
  });
});

describe("needsYouRows — a session appears ONCE", () => {
  it("a cluster filed under the session folds into its card, counted as its N decisions", () => {
    const out = needsYouRows([
      row("slot", { groupKey: "session:S", blockedReason: "physical", sessionTitle: "Tracks-first" }),
      row("cl", { groupKey: "session:S", kind: "proposal-cluster", count: 2 }),
      row("other-cl", { kind: "proposal-cluster", groupKey: "proposal-cluster:k" }),
    ]);
    expect(shape(out.recent)).toEqual(["session:S[slot,cl]", "item:other-cl"]);
    const [card] = out.recent;
    if (card?.kind !== "session") throw new Error("expected a card");
    expect(needsYouCountsLabel(card.counts)).toBe("1 action · 2 decisions");
  });
});

describe("needsYouRows — Older fold + cap", () => {
  it("the fold counts ROWS: a card under it is one", () => {
    const out = needsYouRows([
      row("r"),
      row("o1", { ageBucket: "older", groupKey: "session:Z" }),
      row("o2", { ageBucket: "older", groupKey: "session:Z" }),
      row("o3", { ageBucket: "older" }),
    ]);
    expect(shape(out.older)).toEqual(["session:Z[o1,o2]", "item:o3"]);
    expect(out.olderCount).toBe(2);
  });

  it("caps by ROWS, never splitting a card", () => {
    const { recent } = needsYouRows([
      row("a1", { groupKey: "session:A" }),
      row("a2", { groupKey: "session:A" }),
      row("a3", { groupKey: "session:A" }),
      row("x"),
      row("y"),
    ]);
    const { shown, hiddenRows } = capNeedsYouRows(recent, 2);
    expect(shape(shown)).toEqual(["session:A[a1,a2,a3]", "item:x"]);
    expect(hiddenRows).toBe(1);
  });

  it("hiddenItems is in BADGE units — a hidden card counts its signals, not its proposals", () => {
    const { recent } = needsYouRows([
      row("x"),
      row("a1", { groupKey: "session:A", kind: "proposal-cluster", count: 12 }),
      row("a2", { groupKey: "session:A" }),
      row("y"),
    ]);
    const cut = capNeedsYouRows(recent, 1);
    expect(cut.hiddenRows).toBe(2);
    // card (2 signals) + y (1) — never 12 + 1 + 1.
    expect(cut.hiddenItems).toBe(3);
  });
});
