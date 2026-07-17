import { describe, it, expect } from "vitest";
import { compositeRerank, type RerankRow } from "./composite-rerank.js";

const NOW = new Date("2026-06-13T00:00:00Z").getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

// rows arrive in fused order (best first)
const rows = (...ids: string[]): RerankRow[] =>
  ids.map((id) => ({ id, properties: null, updatedAt: daysAgo(100) }));

describe("compositeRerank — bounded-nudge invariant (the over-boost guard)", () => {
  it("a maximally-recent BOTTOM row does NOT overtake the top RRF hit on a small pool", () => {
    // n=4: the rank-0 row is old; the rank-3 row is brand new. With a span-
    // relative temporal boost the new row rises but cannot pass the top hit.
    const r: RerankRow[] = [
      { id: "top", properties: null, updatedAt: daysAgo(100) },
      { id: "b", properties: null, updatedAt: daysAgo(100) },
      { id: "c", properties: null, updatedAt: daysAgo(100) },
      { id: "fresh", properties: null, updatedAt: new Date(NOW) },
    ];
    const out = compositeRerank(r, {
      propertyHints: [],
      temporal: true,
      now: NOW,
    });
    expect(out[0].id).toBe("top"); // RRF #1 stays #1 — boost is a nudge
    expect(out.findIndex((x) => x.id === "fresh")).toBeLessThan(3); // but it rose
  });

  it("temporal boost is INERT when the query is not temporal", () => {
    const r: RerankRow[] = [
      { id: "a", properties: null, updatedAt: daysAgo(100) },
      { id: "fresh", properties: null, updatedAt: new Date(NOW) },
    ];
    const out = compositeRerank(r, {
      propertyHints: [],
      temporal: false,
      now: NOW,
    });
    expect(out.map((x) => x.id)).toEqual(["a", "fresh"]); // order unchanged
  });

  it("property hint lifts a matching row without displacing the top hit", () => {
    const r: RerankRow[] = [
      { id: "top", properties: null, updatedAt: daysAgo(100) },
      { id: "x", properties: null, updatedAt: daysAgo(100) },
      {
        id: "match",
        properties: { role: "VP Product" },
        updatedAt: daysAgo(100),
      },
      { id: "y", properties: null, updatedAt: daysAgo(100) },
    ];
    const out = compositeRerank(r, {
      propertyHints: [{ key: "role", value: "vp" }],
      temporal: false,
      now: NOW,
    });
    expect(out[0].id).toBe("top"); // hint is a nudge, not a partition
    expect(out.findIndex((x) => x.id === "match")).toBeLessThan(2); // but rose
  });

  it("is a no-op for 0 or 1 rows", () => {
    expect(
      compositeRerank([], { propertyHints: [], temporal: true, now: NOW })
    ).toEqual([]);
    const one = rows("a");
    expect(
      compositeRerank(one, { propertyHints: [], temporal: true, now: NOW })
    ).toEqual(one);
  });

  it("is stable — equal-score rows keep fused order", () => {
    const r = rows("a", "b", "c");
    const out = compositeRerank(r, {
      propertyHints: [],
      temporal: false,
      now: NOW,
    });
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  // ── Type salience (T2): a bounded nudge for high-signal knowledge types ──
  it("a salient-type row rises over neighbours but does NOT overtake the top RRF hit", () => {
    // On a realistic pool the 0.2-span nudge is a meaningful few positions; on a
    // tiny pool it is deliberately sub-rank (bounded). Use n=10 note rows with a
    // salient `decision` at the BOTTOM — it lifts past its neighbours yet the
    // top RRF hit is untouchable (span-relative boost can't span the whole field).
    const r: RerankRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: i === 0 ? "top" : `n${i}`,
      properties: null,
      updatedAt: daysAgo(100),
      type: "note",
    }));
    r[9] = {
      id: "decision",
      properties: null,
      updatedAt: daysAgo(100),
      type: "decision",
    };
    const out = compositeRerank(r, {
      propertyHints: [],
      temporal: false,
      now: NOW,
    });
    expect(out[0].id).toBe("top"); // salience is a nudge, not a partition
    expect(out.findIndex((x) => x.id === "decision")).toBeLessThan(9); // but it rose
  });

  it("salience is inert for untyped / note rows (order unchanged)", () => {
    const r: RerankRow[] = [
      { id: "a", properties: null, updatedAt: daysAgo(100), type: "note" },
      { id: "b", properties: null, updatedAt: daysAgo(100) },
    ];
    const out = compositeRerank(r, {
      propertyHints: [],
      temporal: false,
      now: NOW,
    });
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
