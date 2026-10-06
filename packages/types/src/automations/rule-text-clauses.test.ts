/**
 * MOVED HERE from relay-app with `rule-text-clauses.ts`.
 *
 * THE FOUNDER'S SENTENCE, parsed.
 *
 * "a task when deadline is today" produced `{ trigger: null, actions: [] }` —
 * zero chips — because `matchRuleText` scores whole event LABELS by word
 * coverage and that sentence never reaches the threshold. These two functions
 * answer what coverage cannot: which OBJECT, and what NARROWING.
 */
import { describe, it, expect } from "vitest";
import {
  parseConditionClauses,
  matchObjectSegment,
} from "./rule-text-clauses.js";

const PATTERNS = [
  "task.created",
  "task.updated",
  "invoice.created",
  "external_message.received",
];

describe("the object the sentence is about", () => {
  it("finds it, singular or plural", () => {
    expect(matchObjectSegment("a task when deadline is today", PATTERNS)).toBe(
      "task"
    );
    expect(matchObjectSegment("when tasks change", PATTERNS)).toBe("task");
    expect(matchObjectSegment("any invoice over 500", PATTERNS)).toBe(
      "invoice"
    );
  });

  it("NEVER invents one the pod does not emit", () => {
    // An object that is not an event segment cannot be triggered on, so
    // matching it would author a rule against events that do not exist.
    expect(
      matchObjectSegment("a unicorn when it sparkles", PATTERNS)
    ).toBeNull();
    expect(matchObjectSegment("", PATTERNS)).toBeNull();
    expect(matchObjectSegment("a task", [])).toBeNull();
  });
});

describe("the narrowing the sentence asked for", () => {
  it("parses the founder’s own example", () => {
    expect(parseConditionClauses("a task when deadline is today")).toEqual([
      { field: "deadline", operator: "is_within", value: "today" },
    ]);
  });

  it("parses every date phrase to a window the matcher implements", () => {
    const cases: Array<[string, string]> = [
      ["a task when deadline is overdue", "past"],
      ["a task when deadline is in the past", "past"],
      ["a task when deadline is this week", "next_7_days"],
      ["a task when deadline is in the last 24 hours", "last_24_hours"],
      ["a task when deadline is upcoming", "future"],
    ];
    for (const [text, window] of cases) {
      expect(parseConditionClauses(text)[0]?.value, text).toBe(window);
      expect(parseConditionClauses(text)[0]?.operator, text).toBe("is_within");
    }
  });

  it("parses ordered, text and boolean narrowings", () => {
    expect(
      parseConditionClauses("an invoice when amount is greater than 500")
    ).toEqual([{ field: "amount", operator: "greater_than", value: "500" }]);
    expect(
      parseConditionClauses("a message when subject contains invoice")
    ).toEqual([{ field: "subject", operator: "contains", value: "invoice" }]);
    expect(parseConditionClauses("a task when is paid is true")).toEqual([
      { field: "is paid", operator: "is_true", value: "" },
    ]);
  });

  it('LONGEST PHRASE WINS — a bare "is" must never eat "is greater than"', () => {
    // The ordering of OPERATOR_PHRASES is load-bearing: with "is" first,
    // "amount is greater than 500" parses as `amount is "greater than 500"`,
    // which compiles to a string equality that can never match a number. That
    // is the numeric inversion this grammar already fixed once.
    const [clause] = parseConditionClauses("when amount is greater than 500");
    expect(clause?.operator).toBe("greater_than");
    expect(clause?.value).toBe("500");
  });

  it("ANDs multiple clauses, the way the matcher does", () => {
    expect(
      parseConditionClauses("a task when deadline is today and status is open")
    ).toEqual([
      { field: "deadline", operator: "is_within", value: "today" },
      { field: "status", operator: "is", value: "open" },
    ]);
  });

  it("finds NOTHING when the sentence has no narrowing", () => {
    // A complete rule must not be mined for clauses that are not there.
    expect(parseConditionClauses("an invoice was created")).toEqual([]);
    expect(parseConditionClauses("tell me about tasks")).toEqual([]);
  });

  it("refuses a half-typed clause rather than emitting one that cannot compile", () => {
    // "amount is greater than" with no number would compile to `undefined` and
    // silently WIDEN the rule.
    expect(
      parseConditionClauses("an invoice when amount is greater than")
    ).toEqual([]);
    expect(parseConditionClauses("a task when is today")).toEqual([]);
  });

  it("strips the words people put in front of a property", () => {
    expect(
      parseConditionClauses("a task when the deadline is today")[0]?.field
    ).toBe("deadline");
    expect(
      parseConditionClauses("a task when its deadline is overdue")[0]?.field
    ).toBe("deadline");
  });
});
