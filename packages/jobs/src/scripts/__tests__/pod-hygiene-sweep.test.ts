/**
 * Unit tests for the pure parts of the pod-hygiene-sweep script:
 * the keep-days boundary math, the fixture matcher set, the per-row match
 * predicate, the SQL pre-filter derivation, and CLI arg parsing. The IO paths
 * (DB deletes, blob removal, pg-boss enqueue) are verified via `--execute` dry
 * runs against a real pod, not here.
 */

import { describe, it, expect } from "vitest";
import {
  keepDaysCutoff,
  buildFixtureMatchers,
  fixtureMatches,
  fixtureSqlFilters,
  parseArgs,
  DEFAULT_KEEP_DAYS,
  DEFAULT_LIMIT,
} from "../pod-hygiene-sweep.js";

describe("keepDaysCutoff", () => {
  it("subtracts exactly keepDays from now (UTC)", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    expect(keepDaysCutoff(7, now).toISOString()).toBe(
      "2026-07-10T12:00:00.000Z"
    );
  });

  it("keepDays=0 is a no-op cutoff (equals now)", () => {
    const now = new Date("2026-07-17T00:00:00.000Z");
    expect(keepDaysCutoff(0, now).getTime()).toBe(now.getTime());
  });

  it("does not mutate the passed-in now", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const snapshot = now.getTime();
    keepDaysCutoff(7, now);
    expect(now.getTime()).toBe(snapshot);
  });

  it("a note created before the cutoff is swept; on/after the cutoff is kept", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const cutoff = keepDaysCutoff(7, now);
    const old = new Date("2026-07-09T12:00:00.000Z");
    const fresh = new Date("2026-07-11T12:00:00.000Z");
    expect(old < cutoff).toBe(true); // deleted
    expect(fresh < cutoff).toBe(false); // kept
  });
});

describe("buildFixtureMatchers", () => {
  const matchers = buildFixtureMatchers();

  it("includes exactly two borderline matchers (Bob Smith, Alice Chen)", () => {
    const border = matchers.filter((m) => m.borderline);
    expect(border.map((m) => m.title).sort()).toEqual([
      "Alice Chen",
      "Bob Smith",
    ]);
  });

  it("restricts note-prefix fixtures to the note type", () => {
    const stamp = matchers.find((m) => m.title === "Stamp Synap project");
    expect(stamp?.mode).toBe("prefix");
    expect(stamp?.types).toEqual(["note"]);
  });

  it("restricts named-entity fixtures to person/company", () => {
    const acme = matchers.find((m) => m.title === "Acme Corp");
    expect(acme?.types).toEqual(["person", "company"]);
    expect(acme?.expected).toBe(3);
  });
});

describe("fixtureMatches", () => {
  const matchers = buildFixtureMatchers();
  const byTitle = (t: string) => matchers.find((m) => m.title === t)!;

  it("exact match requires identical title", () => {
    const m = byTitle("Jane Doe");
    expect(fixtureMatches({ title: "Jane Doe", type: "person" }, m)).toBe(true);
    expect(fixtureMatches({ title: "Jane Doe Jr", type: "person" }, m)).toBe(
      false
    );
  });

  it("prefix match catches suffixed titles", () => {
    const m = byTitle("gtest1781999884");
    expect(
      fixtureMatches({ title: "gtest1781999884-a", type: "person" }, m)
    ).toBe(true);
    expect(fixtureMatches({ title: "gtest999", type: "person" }, m)).toBe(
      false
    );
  });

  it("type restriction guards against a real same-named entity", () => {
    const m = byTitle("Jane Doe"); // person/company only
    expect(fixtureMatches({ title: "Jane Doe", type: "note" }, m)).toBe(false);
    expect(fixtureMatches({ title: "Jane Doe", type: "company" }, m)).toBe(
      true
    );
  });

  it("null title never matches", () => {
    const m = byTitle("Acme Corp");
    expect(fixtureMatches({ title: null, type: "company" }, m)).toBe(false);
  });
});

describe("fixtureSqlFilters", () => {
  it("splits matchers into exact titles and LIKE prefix patterns", () => {
    const { exactTitles, prefixPatterns } = fixtureSqlFilters(
      buildFixtureMatchers()
    );
    expect(exactTitles).toContain("Acme Corp");
    expect(exactTitles).toContain("Bob Smith"); // borderline still pre-filtered so it shows in dry runs
    expect(prefixPatterns).toContain("gtest1781999884%");
    expect(prefixPatterns).toContain("CLI-mirror note%");
    // exact titles never carry a wildcard
    expect(exactTitles.some((t) => t.endsWith("%"))).toBe(false);
  });
});

describe("parseArgs", () => {
  const base = ["node", "script"];

  it("defaults to dry-run with no execute and sane fallbacks", () => {
    const o = parseArgs([...base, "--superwhisper"]);
    expect(o.mode).toBe("superwhisper");
    expect(o.execute).toBe(false);
    expect(o.keepDays).toBe(DEFAULT_KEEP_DAYS);
    expect(o.limit).toBe(DEFAULT_LIMIT);
    expect(o.includeBorderline).toBe(false);
  });

  it("parses --keep-days, --limit, --execute, --include-borderline, --json", () => {
    const o = parseArgs([
      ...base,
      "--fixtures",
      "--keep-days",
      "14",
      "--limit",
      "100",
      "--execute",
      "--include-borderline",
      "--json",
    ]);
    expect(o.mode).toBe("fixtures");
    expect(o.keepDays).toBe(14);
    expect(o.limit).toBe(100);
    expect(o.execute).toBe(true);
    expect(o.includeBorderline).toBe(true);
    expect(o.json).toBe(true);
  });

  it("returns null mode when neither mode flag is present", () => {
    expect(parseArgs([...base, "--execute"]).mode).toBeNull();
  });

  it("--superwhisper wins if both mode flags are somehow passed", () => {
    expect(parseArgs([...base, "--fixtures", "--superwhisper"]).mode).toBe(
      "superwhisper"
    );
  });

  it("falls back to defaults on a non-numeric or negative flag value", () => {
    expect(
      parseArgs([...base, "--superwhisper", "--keep-days", "abc"]).keepDays
    ).toBe(DEFAULT_KEEP_DAYS);
    expect(parseArgs([...base, "--superwhisper", "--limit", "-5"]).limit).toBe(
      DEFAULT_LIMIT
    );
  });
});
