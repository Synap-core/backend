/**
 * The shared sentence→words renderer and the cron humaniser, pinned on the
 * SENTENCE (not a surface draft) — the shape the pod's parse door returns and
 * every composer passes. Relay's `sentence-clauses.test.ts` keeps pinning the
 * card and the stored intent against each other over real drafts.
 */
import { describe, expect, it } from "vitest";

import {
  CHANGED_KEY_PREFIX,
  clauseText,
  conditionClauses,
  conditionOperatorLabel,
  conditionTakesValue,
  conditionWindowLabel,
  isChangedFlagKey,
  propertyLabel,
  ruleSentenceText,
} from "./rule-sentence-words.js";
import {
  CRON_RECURRENCES,
  cronExpressionOf,
  matchCronRecurrence,
} from "./cron-recurrence.js";
import { parseCron, type ConditionRow } from "./sentence.js";

const row = (r: Omit<ConditionRow, "id">, id = r.key): ConditionRow => ({
  id,
  ...r,
});

describe("conditionClauses reads the sentence", () => {
  it("renders every row, both shapes, in order", () => {
    const sentence = {
      conditions: [
        row({
          key: `${CHANGED_KEY_PREFIX}status`,
          operator: "is_true",
          value: "",
        }),
        row({ key: "amount", operator: "greater_than", value: "500" }),
        row({ key: "deadline", operator: "is_within", value: "today" }),
      ],
    };
    const clauses = conditionClauses(sentence, [
      { slug: "amount", uiHints: { displayName: "Total amount" } },
    ]);
    expect(clauses.map(clauseText)).toEqual([
      "Status changed",
      "Total amount greater than 500",
      `Deadline ${conditionWindowLabel("today")}`,
    ]);
    expect(clauses.every((c) => !c.incomplete)).toBe(true);
  });

  it("marks a value-taking row with no value as incomplete, never as finished", () => {
    const [c] = conditionClauses({
      conditions: [
        row({ key: "amount", operator: "greater_than", value: " " }),
      ],
    });
    expect(c).toMatchObject({ incomplete: true });
    expect(c).not.toHaveProperty("value");
  });

  it("an unknown window is incomplete, never a raw token", () => {
    const [c] = conditionClauses({
      conditions: [
        row({ key: "deadline", operator: "is_within", value: "fortnight" }),
      ],
    });
    expect(c).toMatchObject({ comparison: "is within", incomplete: true });
    expect(conditionWindowLabel("fortnight")).toBe("");
  });
});

describe("the phrasing", () => {
  it("is the ONE 'As soon as X, Y.' line, conditions ANDed", () => {
    const clauses = conditionClauses({
      conditions: [
        row({ key: "amount", operator: "greater_than", value: "500" }),
      ],
    });
    expect(
      ruleSentenceText("An invoice was updated", ["Tell me"], clauses)
    ).toBe(
      "As soon as An invoice was updated and Amount greater than 500, Tell me."
    );
    expect(ruleSentenceText("A message arrived", [])).toBe(
      "As soon as A message arrived, an action."
    );
  });

  it("operator moods and valueless operators", () => {
    expect(conditionOperatorLabel("greater_than")).toBe("Greater than");
    expect(conditionOperatorLabel("greater_than", "inline")).toBe(
      "greater than"
    );
    expect(conditionTakesValue("is_true")).toBe(false);
    expect(conditionTakesValue("is")).toBe(true);
    expect(isChangedFlagKey("changed.status")).toBe(true);
    expect(isChangedFlagKey("lastChangedBy")).toBe(false);
  });

  it("an authored property label wins over the humanised slug", () => {
    expect(
      propertyLabel("budget", [
        { slug: "budget", uiHints: { label: "Budget (USD)" } },
      ])
    ).toBe("Budget (USD)");
    expect(propertyLabel("some_other_key")).toBe("Some other key");
  });
});

describe("the cron humaniser", () => {
  it("every offered schedule round-trips through the grammar's own parser", () => {
    for (const r of CRON_RECURRENCES) {
      const reparsed = parseCron(cronExpressionOf(r.trigger));
      expect(
        matchCronRecurrence({ triggerType: "cron", ...reparsed })?.id
      ).toBe(r.id);
    }
  });

  it("a schedule outside the offered set has no label — never a wrong one", () => {
    expect(
      matchCronRecurrence({
        triggerType: "cron",
        cronFrequency: "daily",
        cronTime: "17:30",
      })
    ).toBeUndefined();
    expect(matchCronRecurrence(null)).toBeUndefined();
  });
});
