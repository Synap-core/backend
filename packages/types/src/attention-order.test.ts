import { describe, expect, it } from "vitest";
import {
  ATTENTION_LEVELS,
  attentionRank,
  compareAttention,
  mostUrgentAttention,
  sortByAttention,
  wantsAttention,
  type AttentionLevel,
} from "./attention-order.js";

describe("attention order — the ONE ladder a list sorts by", () => {
  it("is exactly this order: error → needs-you → pending → ready → off", () => {
    // The whole contract in one assertion. A rung inserted, removed or moved
    // fails here — which is the point: a silent re-order relocates the "what
    // needs me" row on every screen at once.
    expect([...ATTENTION_LEVELS]).toEqual(["error", "needs-you", "pending", "ready", "off"]);
  });

  it("ranks by position, so the ladder IS the numbering", () => {
    expect(attentionRank("error")).toBe(0);
    expect(attentionRank("needs-you")).toBe(1);
    expect(attentionRank("off")).toBe(4);
    // Strictly increasing: any two rungs compare in ladder order.
    for (let i = 1; i < ATTENTION_LEVELS.length; i += 1) {
      expect(attentionRank(ATTENTION_LEVELS[i]!)).toBeGreaterThan(
        attentionRank(ATTENTION_LEVELS[i - 1]!),
      );
    }
  });

  it("puts a failure above everything and a switched-off thing below everything", () => {
    const others: AttentionLevel[] = ["needs-you", "pending", "ready", "off"];
    for (const level of others) expect(compareAttention("error", level)).toBeLessThan(0);
    const above: AttentionLevel[] = ["error", "needs-you", "pending", "ready"];
    for (const level of above) expect(compareAttention("off", level)).toBeGreaterThan(0);
  });

  it("names exactly the two rungs that ask something of the reader", () => {
    expect(ATTENTION_LEVELS.filter(wantsAttention)).toEqual(["error", "needs-you"]);
  });

  it("sorts a list most-urgent-first and KEEPS the caller's order within a rung", () => {
    const items = [
      { id: "off-a", level: "off" as AttentionLevel },
      { id: "ready-a", level: "ready" as AttentionLevel },
      { id: "err-a", level: "error" as AttentionLevel },
      { id: "ready-b", level: "ready" as AttentionLevel },
      { id: "err-b", level: "error" as AttentionLevel },
      { id: "need-a", level: "needs-you" as AttentionLevel },
    ];
    expect(sortByAttention(items, (i) => i.level).map((i) => i.id)).toEqual([
      "err-a", // the two errors keep their input order…
      "err-b",
      "need-a",
      "ready-a", // …and so do the two readies
      "ready-b",
      "off-a",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const items = [{ v: "off" as AttentionLevel }, { v: "error" as AttentionLevel }];
    const before = [...items];
    sortByAttention(items, (i) => i.v);
    expect(items).toEqual(before);
  });

  it("folds a container to its most urgent member, and returns null for none", () => {
    expect(mostUrgentAttention(["ready", "off", "needs-you"])).toBe("needs-you");
    expect(mostUrgentAttention(["ready"])).toBe("ready");
    expect(mostUrgentAttention([])).toBeNull();
  });

  it("is the SAME ladder every domain maps onto — a tool state and a sync phase agree", () => {
    // The defect this module exists to kill: two surfaces ranking the same
    // facts differently. Both mappings below are the real ones (tools model,
    // connectors model) reduced to their rungs.
    const toolState = (s: string): AttentionLevel =>
      s === "reconnect" || s === "connect" || s === "enable"
        ? "needs-you"
        : s === "blocked"
          ? "pending"
          : s === "ready"
            ? "ready"
            : "off";
    const syncPhase = (p: string): AttentionLevel =>
      p === "failed" ? "error" : p === "running" ? "pending" : p === "success" ? "ready" : "off";

    // A failed sync outranks a tool that merely needs a reconnect, whichever
    // list they appear in — because both ask THIS table.
    expect(compareAttention(syncPhase("failed"), toolState("reconnect"))).toBeLessThan(0);
    expect(compareAttention(toolState("reconnect"), syncPhase("success"))).toBeLessThan(0);
  });
});
