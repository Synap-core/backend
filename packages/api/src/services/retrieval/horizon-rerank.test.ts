import { describe, it, expect } from "vitest";
import {
  horizonScore,
  HORIZON_WEIGHTS,
  type HorizonRow,
  type HorizonOpts,
} from "./horizon-rerank.js";

const NOW = new Date("2026-07-13T12:00:00.000Z").getTime();

function opts(over: Partial<HorizonOpts> = {}): HorizonOpts {
  return {
    lens: "workspace",
    now: NOW,
    viewCounts: new Map(),
    lastTouch: new Map(),
    centrality: new Map(),
    ...over,
  };
}

const rows: HorizonRow[] = [
  { id: "a", updatedAt: new Date("2026-07-13T11:00:00.000Z") },
  { id: "b", updatedAt: new Date("2026-06-13T11:00:00.000Z") },
];

describe("horizonScore", () => {
  it("returns one scored row per input, sorted descending, stable on ties", () => {
    const out = horizonScore(rows, opts());
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
  });

  // Regression: latestEventTimestamps declares Map<string, Date> but a raw SQL
  // MAX(timestamp) aggregate arrives as a STRING from postgres.js. The scorer
  // must coerce it, not call .getTime() on a string (which threw and nuked the
  // whole Horizon rank → empty A/B compare in prod, commit 97d764a).
  it("does NOT throw when lastTouch holds a string (raw SQL aggregate)", () => {
    const lastTouch = new Map<string, Date>([
      // deliberately a string cast through the Date-typed map, as prod did
      ["a", "2026-07-13T11:30:00.000Z" as unknown as Date],
    ]);
    expect(() => horizonScore(rows, opts({ lastTouch }))).not.toThrow();
    const out = horizonScore(rows, opts({ lastTouch }));
    // 'a' with a very recent string last-touch must outrank 'b' (older).
    expect(out[0].row.id).toBe("a");
    expect(out[0].score).toBeGreaterThan(0);
  });

  it("ignores an unparseable last-touch string (recency degrades to 0/updatedAt)", () => {
    const lastTouch = new Map<string, Date>([
      ["a", "not-a-date" as unknown as Date],
    ]);
    // Unparseable string → toDate(null) on lastTouch, falls back to updatedAt.
    expect(() => horizonScore(rows, opts({ lastTouch }))).not.toThrow();
  });
});

// ── Lens (S1): L is the shared lens signal, no longer folded to 0 ──
describe("horizonScore — lens term L", () => {
  const same = new Date("2026-07-10T00:00:00.000Z");
  // Two rows equal on every signal but fused position; the second is in focus.
  const pair: HorizonRow[] = [
    { id: "out", updatedAt: same, workspaceId: "ws-other" },
    { id: "in", updatedAt: same, workspaceId: "ws-focus" },
  ];

  it("each lens profile's weights sum to 1 with L restored", () => {
    for (const w of Object.values(HORIZON_WEIGHTS)) {
      expect(w.L).toBeGreaterThan(0);
      expect(w.R + w.F + w.C + w.Q + w.L).toBeCloseTo(1, 10);
    }
  });

  it("a row in focus outranks an otherwise equal row out of focus (project profile)", () => {
    const out = horizonScore(
      pair,
      opts({ lens: "project", focus: { workspaceId: "ws-focus" } })
    );
    expect(out.map((x) => x.row.id)).toEqual(["in", "out"]);
    expect(out).toHaveLength(2); // the out-of-focus row is still returned
  });

  it("the bound holds: a far more relevant out-of-focus row still wins (workspace profile)", () => {
    // Q gives the top hit 0.25 over the bottom; L can add at most 0.05.
    const out = horizonScore(
      pair,
      opts({ lens: "workspace", focus: { workspaceId: "ws-focus" } })
    );
    expect(out.map((x) => x.row.id)).toEqual(["out", "in"]);
    const lift = out[1].score - horizonScore(pair, opts())[1].score;
    expect(lift).toBeCloseTo(HORIZON_WEIGHTS.workspace.L, 10);
  });

  it("L is 0 with no focus: scores are unchanged", () => {
    const a = horizonScore(pair, opts({ lens: "project" }));
    const b = horizonScore(
      pair,
      opts({ lens: "project", focus: { workspaceId: "ws-none" } })
    );
    expect(a.map((x) => x.score)).toEqual(b.map((x) => x.score));
  });
});
