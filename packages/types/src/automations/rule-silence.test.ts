import { describe, it, expect } from "vitest";
import {
  ruleSilence,
  SILENCE_FACTOR,
  SILENCE_FLOOR_MS,
  SILENCE_MIN_RUNS,
} from "./rule-silence.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-05T12:00:00Z");
/** n runs, `every` ms apart, the newest `quiet` ms ago. */
const runs = (n: number, every: number, quiet: number) =>
  Array.from(
    { length: n },
    (_, i) => new Date(now.getTime() - quiet - i * every)
  );

describe("ruleSilence — a rule that normally fires and has stopped", () => {
  it("a daily rule quiet for 4 days is silent", () => {
    const r = ruleSilence({
      status: "active",
      runStartedAt: runs(10, DAY, 4 * DAY),
      now,
    });
    expect(r.usualIntervalMs).toBe(DAY);
    expect(r.silent).toBe(true);
  });

  it("the same rule quiet for 2 days is not (under the factor)", () => {
    expect(
      ruleSilence({
        status: "active",
        runStartedAt: runs(10, DAY, 2 * DAY),
        now,
      }).silent
    ).toBe(false);
  });

  it("a fast rule is never silent before the floor", () => {
    const every = 2 * 60 * 1000;
    const quiet = SILENCE_FLOOR_MS - 60_000; // >> 3× two minutes, < the floor
    expect(quiet).toBeGreaterThan(SILENCE_FACTOR * every);
    expect(
      ruleSilence({
        status: "active",
        runStartedAt: runs(20, every, quiet),
        now,
      }).silent
    ).toBe(false);
  });

  it("too little history is not a rhythm", () => {
    const r = ruleSilence({
      status: "active",
      runStartedAt: runs(SILENCE_MIN_RUNS - 1, DAY, 30 * DAY),
      now,
    });
    expect(r.silent).toBe(false);
    expect(r.usualIntervalMs).toBeNull();
  });

  it("a paused rule is quiet on purpose", () => {
    expect(
      ruleSilence({
        status: "paused",
        runStartedAt: runs(10, DAY, 9 * DAY),
        now,
      }).silent
    ).toBe(false);
  });

  it("the median ignores one burst (a sync that fired 5 times in a minute)", () => {
    const burst = runs(5, 10_000, 0).map(
      (d) => new Date(d.getTime() - 10 * DAY)
    );
    const daily = runs(8, DAY, 4 * DAY);
    const r = ruleSilence({
      status: "active",
      runStartedAt: [...daily, ...burst],
      now,
    });
    expect(r.silent).toBe(true);
  });
});
