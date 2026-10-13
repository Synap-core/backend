import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDate, formatRelative, isUuid, oneLine } from "./format";

const NOW = new Date("2026-06-15T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelative", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("renders a missing or invalid date as the empty string", () => {
    expect(formatRelative(null, { empty: "" })).toBe("");
    expect(formatRelative("not a date", { empty: "" })).toBe("");
    expect(formatRelative(undefined)).toBe("—");
  });

  it("reads anything within a minute either side of now as just now", () => {
    expect(formatRelative(at(-30_000))).toBe("just now");
    expect(formatRelative(at(30_000))).toBe("just now");
  });

  it("reads the future and the past in the coarsest whole unit", () => {
    expect(formatRelative(at(2 * HOUR))).toBe("in 2h");
    expect(formatRelative(at(-3 * DAY))).toBe("3d ago");
    expect(formatRelative(at(-45 * DAY))).toBe("1mo ago");
  });
});

describe("oneLine", () => {
  it("folds whitespace and keeps short text whole", () => {
    expect(oneLine("  a\n\t b  ", 10)).toBe("a b");
  });

  it("cuts long text at max with an ellipsis, no trailing space", () => {
    expect(oneLine("abc def ghi", 4)).toBe("abc…");
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isUuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x")).toBe(false);
  });
});

describe("formatDate", () => {
  it("reads a day, and a dash for nothing or garbage", () => {
    expect(formatDate("2026-08-03T12:00:00Z")).toMatch(/2026/);
    expect(formatDate("2026-08-03T12:00:00Z")).not.toMatch(/:/);
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});
