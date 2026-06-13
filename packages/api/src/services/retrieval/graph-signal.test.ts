import { describe, it, expect } from "vitest";
import {
  buildAdjacency,
  pprLitePropagate,
  graphExpand,
} from "./graph-signal.js";

describe("buildAdjacency", () => {
  it("builds an undirected map and drops self-loops/blanks", () => {
    const adj = buildAdjacency([
      { src: "A", tgt: "B" },
      { src: "B", tgt: "C" },
      { src: "X", tgt: "X" }, // self-loop dropped
      { src: "", tgt: "Y" }, // blank dropped
    ]);
    expect([...(adj.get("A") ?? [])]).toEqual(["B"]);
    expect([...(adj.get("B") ?? [])].sort()).toEqual(["A", "C"]);
    expect(adj.has("X")).toBe(false);
  });
});

describe("pprLitePropagate", () => {
  const adj = buildAdjacency([
    { src: "A", tgt: "B" },
    { src: "B", tgt: "C" },
  ]);

  it("surfaces a directly-connected neighbor (1 hop)", () => {
    const r = pprLitePropagate([{ id: "A", weight: 0.1 }], adj, 0.5, 1);
    expect(r[0].id).toBe("B");
    expect(r[0].score).toBeCloseTo(0.05); // 0.5 * 0.1 / 1 neighbor
  });

  it("reaches a two-hop neighbor with hops=2", () => {
    const r = pprLitePropagate([{ id: "A", weight: 0.1 }], adj, 0.5, 2);
    expect(r.map((x) => x.id)).toContain("C");
  });

  it("never returns the seed ids themselves", () => {
    const r = pprLitePropagate([{ id: "A", weight: 0.1 }], adj, 0.5, 2);
    expect(r.map((x) => x.id)).not.toContain("A");
  });

  it("returns empty when seeds have no edges", () => {
    expect(
      pprLitePropagate([{ id: "Z", weight: 1 }], adj, 0.5, 1)
    ).toHaveLength(0);
  });

  it("ranks a shared neighbor of two seeds highest", () => {
    // hub H connected to both seeds A and B; D only to A
    const a = buildAdjacency([
      { src: "A", tgt: "H" },
      { src: "B", tgt: "H" },
      { src: "A", tgt: "D" },
    ]);
    const r = pprLitePropagate(
      [
        { id: "A", weight: 0.1 },
        { id: "B", weight: 0.1 },
      ],
      a,
      0.5,
      1
    );
    expect(r[0].id).toBe("H"); // gets weight from both seeds
  });
});

describe("graphExpand (with injected fetcher)", () => {
  it("expands seeds to connected entities via the relation graph", async () => {
    const r = await graphExpand([{ id: "deal1", weight: 0.1 }], "user1", {
      fetchEdges: async () => [
        { src: "deal1", tgt: "company1" },
        { src: "company1", tgt: "person1" },
      ],
      hops: 2,
    });
    const ids = r.map((x) => x.id);
    expect(ids).toContain("company1");
    expect(ids).toContain("person1");
    expect(ids).not.toContain("deal1"); // seed excluded
  });

  it("returns empty for no seeds", async () => {
    expect(
      await graphExpand([], "user1", { fetchEdges: async () => [] })
    ).toEqual([]);
  });
});
