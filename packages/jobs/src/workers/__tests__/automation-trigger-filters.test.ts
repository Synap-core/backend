/**
 * THE regression pin for the 2026-08-16 finding: every event-automation on the
 * live pod was authored with operator-object filters
 * (`{ profileSlug: { $in: ["person","contact"] } }`) while `matchFilters` did a
 * bare `actual !== expected`, so each one was permanently unreachable while
 * reporting `status: active` and `runCount: 0`.
 *
 * Two contracts are pinned here and must both hold:
 *   1. operator objects EVALUATE (the fix), and
 *   2. plain values behave EXACTLY as before (no automation that fires today
 *      can stop firing).
 *
 * The three cases named `LIVE POD` are the actual triggerConfigs found on the
 * pod — they are the acceptance criterion for this change.
 */
import { describe, it, expect } from "vitest";
import { matchFilters } from "../automation-trigger-matcher.js";
import {
  validateTriggerFilters,
  evaluateTriggerFilterValue,
} from "@synap-core/types/automations/filter-operators";

describe("matchFilters — plain values (behaviour must be unchanged)", () => {
  it("matches an exact string / number / boolean / null", () => {
    expect(
      matchFilters({ profileSlug: "person" }, { profileSlug: "person" })
    ).toBe(true);
    expect(matchFilters({ n: 5 }, { n: 5 })).toBe(true);
    expect(matchFilters({ b: false }, { b: false })).toBe(true);
    expect(matchFilters({ v: null }, { v: null })).toBe(true);
  });

  it('stays STRICT: 5 does not match "5"', () => {
    expect(matchFilters({ n: 5 }, { n: "5" })).toBe(false);
  });

  it("rejects a mismatch, and requires every key", () => {
    expect(
      matchFilters({ profileSlug: "note" }, { profileSlug: "person" })
    ).toBe(false);
    expect(matchFilters({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("reads dot-notation paths into nested event data", () => {
    expect(
      matchFilters(
        { channel: { contextObjectType: "entity" } },
        { "channel.contextObjectType": "entity" }
      )
    ).toBe(true);
  });

  it("an empty/absent filter map matches everything; a filter with no data does not", () => {
    expect(matchFilters({ a: 1 }, {})).toBe(true);
    expect(matchFilters({ a: 1 }, undefined)).toBe(true);
    expect(matchFilters(undefined, { a: 1 })).toBe(false);
  });
});

describe("matchFilters — operator objects (THE fix)", () => {
  it("LIVE POD: New Contact Enrichment — profileSlug $in [person, contact]", () => {
    const filters = { profileSlug: { $in: ["person", "contact"] } };
    expect(matchFilters({ profileSlug: "person" }, filters)).toBe(true);
    expect(matchFilters({ profileSlug: "contact" }, filters)).toBe(true);
    expect(matchFilters({ profileSlug: "note" }, filters)).toBe(false);
  });

  it("LIVE POD: Strength Score Computation — profileSlug $eq person", () => {
    const filters = { profileSlug: { $eq: "person" } };
    expect(matchFilters({ profileSlug: "person" }, filters)).toBe(true);
    expect(matchFilters({ profileSlug: "company" }, filters)).toBe(false);
  });

  it("LIVE POD: Interaction Summary — channel.contextObjectType $eq entity", () => {
    const filters = { "channel.contextObjectType": { $eq: "entity" } };
    expect(
      matchFilters({ channel: { contextObjectType: "entity" } }, filters)
    ).toBe(true);
    expect(
      matchFilters({ channel: { contextObjectType: "channel" } }, filters)
    ).toBe(false);
  });

  it("$ne", () => {
    expect(matchFilters({ s: "a" }, { s: { $ne: "b" } })).toBe(true);
    expect(matchFilters({ s: "a" }, { s: { $ne: "a" } })).toBe(false);
  });

  it("$gt/$gte/$lt/$lte compare numerically, including numeric strings", () => {
    expect(matchFilters({ score: 40 }, { score: { $gt: 30 } })).toBe(true);
    expect(matchFilters({ score: 30 }, { score: { $gt: 30 } })).toBe(false);
    expect(matchFilters({ score: 30 }, { score: { $gte: 30 } })).toBe(true);
    expect(matchFilters({ score: "40" }, { score: { $gt: 30 } })).toBe(true);
    expect(matchFilters({ score: 10 }, { score: { $lt: 30 } })).toBe(true);
    expect(matchFilters({ score: 30 }, { score: { $lte: 30 } })).toBe(true);
  });

  it("a non-numeric value falls OUT of a numeric comparison (SQL NULL parity)", () => {
    expect(matchFilters({ score: "high" }, { score: { $gt: 30 } })).toBe(false);
    expect(matchFilters({}, { score: { $gt: 30 } })).toBe(false);
  });

  it("ANDs multiple operators in one object", () => {
    const filters = { score: { $gte: 10, $lt: 20 } };
    expect(matchFilters({ score: 15 }, filters)).toBe(true);
    expect(matchFilters({ score: 25 }, filters)).toBe(false);
  });
});

describe("matchFilters — fail-closed on unevaluable shapes (pre-change parity)", () => {
  it("an unknown operator does not match (and did not before)", () => {
    expect(matchFilters({ s: "abc" }, { s: { $regex: "a" } })).toBe(false);
  });

  it("an array value compares by identity — never matches, as before", () => {
    expect(matchFilters({ s: "a" }, { s: ["a", "b"] })).toBe(false);
    expect(matchFilters({ s: ["a"] }, { s: ["a"] })).toBe(false);
  });

  it("a nested-object value compares by identity — never matches, as before", () => {
    expect(matchFilters({ s: { a: 1 } }, { s: { a: 1 } })).toBe(false);
  });

  it("a mixed $-and-plain key object is NOT an operator object", () => {
    expect(matchFilters({ s: "a" }, { s: { $in: ["a"], name: "x" } })).toBe(
      false
    );
  });
});

describe("validateTriggerFilters — the create door accepts exactly what the matcher evaluates", () => {
  const accepted: Array<[string, unknown]> = [
    ["plain string", { profileSlug: "person" }],
    ["plain number/boolean/null", { a: 1, b: true, c: null }],
    ["dot-notation key", { "channel.contextObjectType": "entity" }],
    ["$in", { profileSlug: { $in: ["person", "contact"] } }],
    ["$eq", { profileSlug: { $eq: "person" } }],
    ["$ne", { s: { $ne: "x" } }],
    ["numeric ops", { score: { $gte: 10, $lt: 20 } }],
    ["numeric string operand", { score: { $gt: "30" } }],
    ["absent filters", undefined],
  ];
  for (const [name, filters] of accepted) {
    it(`accepts ${name}`, () => {
      expect(validateTriggerFilters(filters)).toEqual({ ok: true });
    });
  }

  const rejected: Array<[string, unknown, RegExp]> = [
    ["a bare array value", { s: ["a", "b"] }, /\$in/],
    ["a nested object value", { s: { a: 1 } }, /dot-notation/],
    [
      "an unknown operator",
      { s: { $regex: "a" } },
      /unsupported operator "\$regex"/,
    ],
    ["an empty $in", { s: { $in: [] } }, /non-empty array/],
    ["a non-array $in", { s: { $in: "a" } }, /non-empty array/],
    ["a non-numeric $gt", { s: { $gt: "soon" } }, /compared numerically/],
    [
      "an object $eq operand",
      { s: { $eq: { a: 1 } } },
      /string, number, boolean or null/,
    ],
    ["a non-object filters map", ["a"], /must be an object/],
  ];
  for (const [name, filters, message] of rejected) {
    it(`rejects ${name}`, () => {
      const result = validateTriggerFilters(filters);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
    });
  }

  it("THE INVARIANT: nothing the door accepts is unevaluable by the matcher", () => {
    // Every accepted filter above, given a payload that should satisfy it,
    // must produce a real `true` — a door that accepts an inert filter is the
    // bug this whole change exists to kill.
    expect(
      matchFilters(
        { profileSlug: "person" },
        { profileSlug: { $in: ["person"] } }
      )
    ).toBe(true);
    expect(evaluateTriggerFilterValue("person", { $eq: "person" })).toBe(true);
    expect(evaluateTriggerFilterValue(30, { $gt: "20" })).toBe(true);
  });
});
