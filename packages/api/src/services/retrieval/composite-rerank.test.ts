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

// ── Lens (S1): the caller's focus is a bounded nudge, never a filter ──
describe("compositeRerank — lens focus", () => {
  const FOCUS = { workspaceId: "ws-focus" };
  // n=10, fused order; only the BOTTOM row lives in the focus workspace.
  const pool = (): RerankRow[] =>
    Array.from({ length: 10 }, (_, i) => ({
      id: i === 9 ? "focused" : `r${i}`,
      properties: null,
      updatedAt: daysAgo(100),
      workspaceId: i === 9 ? "ws-focus" : "ws-other",
    }));
  const opts = { propertyHints: [], temporal: false, now: NOW };

  it("a focused row is boosted, and every unfocused row is still returned", () => {
    const out = compositeRerank(pool(), { ...opts, focus: FOCUS });
    expect(out.findIndex((x) => x.id === "focused")).toBeLessThan(9); // rose
    expect(out).toHaveLength(10); // nothing hidden
    expect(new Set(out.map((x) => x.id))).toEqual(
      new Set(pool().map((x) => x.id))
    );
  });

  it("a row in focus outranks an equal row out of focus", () => {
    const r: RerankRow[] = [
      { id: "out", properties: null, updatedAt: daysAgo(100) },
      {
        id: "in",
        properties: null,
        updatedAt: daysAgo(100),
        workspaceId: "ws-focus",
      },
    ];
    // Equal evidence = adjacent fused positions; the in-focus one is behind.
    expect(compositeRerank(r, opts).map((x) => x.id)).toEqual(["out", "in"]);
    const n = 11; // a span wide enough for the 0.3 nudge to pass one row
    const wide: RerankRow[] = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      properties: null,
      updatedAt: daysAgo(100),
      workspaceId: i === n - 1 ? "ws-focus" : null,
    }));
    const out = compositeRerank(wide, { ...opts, focus: FOCUS });
    expect(out.indexOf(wide[n - 1])).toBeLessThan(out.indexOf(wide[n - 2]));
  });

  it("the nudge is bounded: a far more relevant out-of-focus row still wins", () => {
    const out = compositeRerank(pool(), { ...opts, focus: FOCUS });
    expect(out[0].id).toBe("r0"); // the top recall hit is untouchable
    // The lift is at most LENS_FRACTION of the span (0.3 × 9 = 2.7 positions).
    expect(out.findIndex((x) => x.id === "focused")).toBeGreaterThanOrEqual(6);
  });

  it("is inert with no focus (order unchanged)", () => {
    expect(compositeRerank(pool(), opts).map((x) => x.id)).toEqual(
      pool().map((x) => x.id)
    );
  });
});
