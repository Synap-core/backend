/**
 * Numbers, counts, sizes, progress and durations, in English and French (plan
 * 915cc937 P3). The English vectors are the outputs of the formatters these
 * replace (relay `src/lib/format.ts`, web `formatDurationMs`), so a host that
 * re-exports from here reads the same. French: decimal comma, U+202F between
 * thousands, U+00A0 between a number and its unit, bytes in octets.
 */
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompactCount,
  formatDuration,
  formatFloorCount,
  formatNumber,
  formatProgress,
} from "./numbers.js";

const fr = { locale: "fr" } as const;

describe("formatNumber", () => {
  it("English: comma thousands, decimal point, at most 3 decimals", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(-1234.5)).toBe("-1,234.5");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(2.34567)).toBe("2.346");
  });

  it("French: decimal comma, narrow no-break space thousands", () => {
    expect(formatNumber(1234.5, fr)).toBe("1\u202f234,5");
    expect(formatNumber(1000000, fr)).toBe("1\u202f000\u202f000");
    expect(formatNumber(999, fr)).toBe("999");
    expect(formatNumber(-0.5, fr)).toBe("-0,5");
  });

  it("fraction digits: padded to the minimum, rounded to the maximum", () => {
    expect(formatNumber(4, { minimumFractionDigits: 1 })).toBe("4.0");
    expect(formatNumber(4.25, { ...fr, maximumFractionDigits: 1 })).toBe("4,3");
    expect(formatNumber(1.96, { maximumFractionDigits: 1 })).toBe("2");
  });

  it("never '-0', and a value with no fixed form prints as JS does", () => {
    expect(formatNumber(-0.0001)).toBe("0");
    expect(formatNumber(Number.NaN)).toBe("NaN");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(formatNumber(1e21)).toBe("1e+21");
  });

  it("an unsupported locale reads as English, never a crash", () => {
    expect(formatNumber(1234.5, { locale: "fr-FR" as never })).toBe("1,234.5");
  });
});

describe("formatFloorCount in French", () => {
  it("the floor mark is the same; the number is French", () => {
    expect(formatFloorCount(100, true, fr)).toBe("100+");
    expect(formatFloorCount(1200, false, fr)).toBe("1\u202f200");
  });
});

describe("formatCompactCount", () => {
  it.each([
    [950, "950"],
    [1000, "1k"],
    [1200, "1.2k"],
    [9999, "10k"],
    [12_000, "12k"],
    [999_400, "999k"],
    [999_600, "1M"],
    [1_500_000, "1.5M"],
    [40_000_000, "40M"],
  ])("English %d → %s", (n, expected) => {
    expect(formatCompactCount(n)).toBe(expected);
  });

  it("French: decimal comma and a no-break space before the unit", () => {
    expect(formatCompactCount(1200, fr)).toBe("1,2\u00a0k");
    expect(formatCompactCount(12_000, fr)).toBe("12\u00a0k");
    expect(formatCompactCount(1_500_000, fr)).toBe("1,5\u00a0M");
    expect(formatCompactCount(950, fr)).toBe("950");
  });
});

describe("formatBytes", () => {
  it("English, decimal units, one decimal below 10", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(412_000)).toBe("412 KB");
    expect(formatBytes(2_100_000)).toBe("2.1 MB");
    expect(formatBytes(2_000_000)).toBe("2.0 MB");
    expect(formatBytes(3e15)).toBe("3,000 TB");
  });

  it("French, in octets", () => {
    expect(formatBytes(512, fr)).toBe("512\u00a0o");
    expect(formatBytes(412_000, fr)).toBe("412\u00a0Ko");
    expect(formatBytes(2_100_000, fr)).toBe("2,1\u00a0Mo");
    expect(formatBytes(5_000_000_000, fr)).toBe("5,0\u00a0Go");
  });

  it("'' for a size that is not one", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN, fr)).toBe("");
  });
});

describe("formatProgress", () => {
  it("3 of 5 / 3 sur 5", () => {
    expect(formatProgress(3, 5)).toBe("3 of 5");
    expect(formatProgress(3, 5, fr)).toBe("3 sur 5");
    expect(formatProgress(1200, 3000, fr)).toBe("1\u202f200 sur 3\u202f000");
  });
});

describe("formatDuration", () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  it.each([
    [850, "850ms", "850\u00a0ms"],
    [4200, "4.2s", "4,2\u00a0s"],
    [4000, "4.0s", "4,0\u00a0s"],
    [12 * M + 5 * S, "12m 5s", "12\u00a0min 5\u00a0s"],
    [3 * H + 5 * M, "3h 5m", "3\u00a0h 5\u00a0min"],
    [52 * H, "2d 4h", "2\u00a0j 4\u00a0h"],
  ])("%d ms → %s / %s", (ms, en, french) => {
    expect(formatDuration(ms)).toBe(en);
    expect(formatDuration(ms, fr)).toBe(french);
  });

  it("'' for a negative or non-finite span", () => {
    expect(formatDuration(-5)).toBe("");
    expect(formatDuration(Number.NaN, fr)).toBe("");
  });
});
