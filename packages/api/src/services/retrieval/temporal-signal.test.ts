import { describe, it, expect } from "vitest";
import { recencyScore } from "./temporal-signal.js";

const NOW = new Date("2026-06-13T00:00:00Z").getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

describe("recencyScore", () => {
  it("is ~1 for just-now and decays by half every 7 days", () => {
    expect(recencyScore({ updatedAt: new Date(NOW) }, NOW)).toBeCloseTo(1);
    expect(recencyScore({ updatedAt: daysAgo(7) }, NOW)).toBeCloseTo(0.5);
    expect(recencyScore({ updatedAt: daysAgo(14) }, NOW)).toBeCloseTo(0.25);
  });

  it("prefers the event-chain timestamp over updatedAt", () => {
    // row updated long ago, but a recent event → high recency
    const s = recencyScore({ updatedAt: daysAgo(30) }, NOW, daysAgo(1));
    expect(s).toBeGreaterThan(0.8);
  });

  it("returns 0 for missing/unparseable timestamps", () => {
    expect(recencyScore({ updatedAt: null }, NOW)).toBe(0);
    expect(recencyScore({ updatedAt: "not-a-date" }, NOW)).toBe(0);
  });

  it("returns 1 for future-dated (upcoming) timestamps", () => {
    expect(recencyScore({ updatedAt: daysAgo(-5) }, NOW)).toBe(1);
  });

  it("accepts ISO strings", () => {
    expect(
      recencyScore({ updatedAt: new Date(NOW).toISOString() }, NOW)
    ).toBeCloseTo(1);
  });
});
