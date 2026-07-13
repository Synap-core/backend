import { describe, it, expect } from "vitest";
import {
  horizonScore,
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
