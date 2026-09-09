/**
 * DATES PARTICIPATE — the unlock for "a task when deadline is today".
 *
 * `toComparableNumber` returned `undefined` for every ISO string, so
 * `$gt/$gte/$lt/$lte` failed closed on any date and the authoring grammar had to
 * refuse the whole `date` value type (`CONDITION_OPERATORS_BY_VALUE_TYPE.date`
 * was `[]`). The founder's own example was the one sentence the system could not
 * express.
 *
 * Two halves, tested separately because they fail differently:
 *   1. ORDERED comparison of dates — needs no new operator names, only coercion.
 *   2. `$within`, a closed set of relative windows resolved against NOW.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateTriggerFilterValue,
  validateTriggerFilters,
  isWithinWindow,
  TRIGGER_FILTER_WINDOWS,
} from "./filter-operators.js";

/** A fixed instant so nothing here depends on when the suite runs. */
const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

describe("ordered comparison understands dates", () => {
  it("an ISO date compares against an ISO date", () => {
    const deadline = "2026-09-10T09:00:00.000Z";
    expect(
      evaluateTriggerFilterValue(deadline, { $lt: "2026-09-11T00:00:00.000Z" })
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(deadline, { $lt: "2026-09-01T00:00:00.000Z" })
    ).toBe(false);
  });

  it("a bare calendar date works, and a Date instance does too", () => {
    expect(
      evaluateTriggerFilterValue("2026-09-10", { $gt: "2026-09-01" })
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(new Date("2026-09-10T00:00:00Z"), {
        $gt: "2026-09-01",
      })
    ).toBe(true);
  });

  it("REGRESSION FLOOR: numeric text keeps precedence and does not become a year", () => {
    // "2026" must stay the NUMBER 2026. If it silently became a date, every
    // stored numeric filter would change meaning — the one thing this widening
    // is not allowed to do.
    expect(evaluateTriggerFilterValue("2026", { $gt: 2025 })).toBe(true);
    expect(evaluateTriggerFilterValue("2026", { $lt: 2027 })).toBe(true);
  });

  it("STRICTLY WIDENING: what could not compare still cannot", () => {
    // Only values that previously returned `undefined` may now coerce. Garbage
    // must still fail closed rather than parse loosely — `Date.parse` accepts
    // things like "March 3" on some engines, which would make a rule's meaning
    // depend on the host.
    for (const junk of ["not a date", "2026 foo", "March 3", "", "  "]) {
      expect(
        evaluateTriggerFilterValue(junk, { $gt: "2026-01-01" }),
        `"${junk}" must not coerce`
      ).toBe(false);
    }
  });

  it("a non-participating value drops the row rather than matching", () => {
    expect(evaluateTriggerFilterValue(null, { $lt: "2026-09-11" })).toBe(false);
    expect(evaluateTriggerFilterValue(undefined, { $lt: "2026-09-11" })).toBe(
      false
    );
  });
});

describe("$within — relative windows, resolved at evaluation", () => {
  it("today matches an instant inside the UTC day and nothing outside it", () => {
    expect(
      evaluateTriggerFilterValue(iso(NOW), { $within: "today" }, NOW)
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(
        "2026-09-09T00:00:00.000Z",
        { $within: "today" },
        NOW
      )
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(
        "2026-09-08T23:59:59.000Z",
        { $within: "today" },
        NOW
      )
    ).toBe(false);
    expect(
      evaluateTriggerFilterValue(
        "2026-09-10T00:00:00.000Z",
        { $within: "today" },
        NOW
      )
    ).toBe(false);
  });

  it("past and future split on now", () => {
    expect(
      evaluateTriggerFilterValue(iso(NOW - 1), { $within: "past" }, NOW)
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(iso(NOW + 1), { $within: "past" }, NOW)
    ).toBe(false);
    expect(
      evaluateTriggerFilterValue(iso(NOW), { $within: "future" }, NOW)
    ).toBe(true);
  });

  it("the rolling windows are inclusive of now and exclusive at the far edge", () => {
    expect(
      evaluateTriggerFilterValue(iso(NOW), { $within: "next_7_days" }, NOW)
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(
        iso(NOW + 7 * DAY),
        { $within: "next_7_days" },
        NOW
      )
    ).toBe(false);
    expect(
      evaluateTriggerFilterValue(
        iso(NOW - 7 * DAY + 1),
        { $within: "last_7_days" },
        NOW
      )
    ).toBe(true);
  });

  it("EVERY declared window is implemented — none silently fails closed", () => {
    // A window in the vocabulary that `isWithinWindow` does not handle would
    // return false for everything: a rule that saves, reads correctly, and
    // never fires. Derived from the table so a new window joins by existing.
    const names = Object.keys(TRIGGER_FILTER_WINDOWS);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const w of names) {
      const inside = [NOW, NOW - 1, NOW + 1, NOW - DAY / 2, NOW + DAY / 2].some(
        (t) => isWithinWindow(iso(t), w, NOW)
      );
      expect(
        inside,
        `window "${w}" matches nothing near now — is it implemented?`
      ).toBe(true);
    }
  });

  it("an unknown window fails closed at evaluation AND is refused at the door", () => {
    expect(
      evaluateTriggerFilterValue(iso(NOW), { $within: "yesterdayish" }, NOW)
    ).toBe(false);
    const bad = validateTriggerFilters({ dueAt: { $within: "yesterdayish" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/\$within must be one of/);
  });
});

describe("the create door accepts exactly what the matcher can evaluate", () => {
  it("accepts an ISO operand on an ordered operator", () => {
    expect(
      validateTriggerFilters({ dueAt: { $lt: "2026-09-11T00:00:00Z" } })
    ).toEqual({
      ok: true,
    });
  });

  it("accepts every declared window", () => {
    for (const w of Object.keys(TRIGGER_FILTER_WINDOWS)) {
      expect(validateTriggerFilters({ dueAt: { $within: w } }), w).toEqual({
        ok: true,
      });
    }
  });

  it("still refuses an operand that cannot be ordered", () => {
    const bad = validateTriggerFilters({ dueAt: { $lt: "whenever" } });
    expect(bad.ok).toBe(false);
  });
});

describe("$contains / $starts_with — the text and membership unlock", () => {
  it("matches a substring, case-insensitively", () => {
    // The case rule is the point: a user writes "invoice" in their own words
    // and means to catch "Invoice #42". A case-sensitive substring test is a
    // rule that looks right and never fires on the rows it was written for.
    expect(
      evaluateTriggerFilterValue("Invoice #42", { $contains: "invoice" })
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue("Receipt #42", { $contains: "invoice" })
    ).toBe(false);
    expect(
      evaluateTriggerFilterValue("Invoice #42", { $starts_with: "inv" })
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue("Re: Invoice", { $starts_with: "inv" })
    ).toBe(false);
  });

  it("matches membership in an array, EXACTLY", () => {
    // Array membership is a different comparison and stays exact — `===` per
    // element, the same test `$in` makes in the other direction.
    expect(
      evaluateTriggerFilterValue(["urgent", "ops"], { $contains: "urgent" })
    ).toBe(true);
    expect(
      evaluateTriggerFilterValue(["Urgent"], { $contains: "urgent" })
    ).toBe(false);
    expect(evaluateTriggerFilterValue(["a"], { $contains: "b" })).toBe(false);
  });

  it("fails closed on a shape it cannot test", () => {
    expect(evaluateTriggerFilterValue(42, { $contains: "4" })).toBe(false);
    expect(evaluateTriggerFilterValue(null, { $contains: "x" })).toBe(false);
    expect(evaluateTriggerFilterValue({ a: 1 }, { $contains: "a" })).toBe(
      false
    );
    // A non-primitive operand is never a substring or an element.
    expect(evaluateTriggerFilterValue("abc", { $contains: ["a"] })).toBe(false);
  });

  it("the create door accepts them", () => {
    expect(
      validateTriggerFilters({ subject: { $contains: "invoice" } })
    ).toEqual({ ok: true });
    expect(
      validateTriggerFilters({ subject: { $starts_with: "Re:" } })
    ).toEqual({ ok: true });
  });
});
