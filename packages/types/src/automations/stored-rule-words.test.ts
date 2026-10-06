import { describe, expect, it } from "vitest";
import {
  CRON_RECURRENCES,
  cronExpressionOf,
  cronWords,
} from "./cron-recurrence.js";
import { flowToConditions } from "./sentence.js";
import {
  actionPhrase,
  eventPatternWhenText,
  ruleThenWords,
  ruleWhenWords,
} from "./stored-rule-words.js";

/**
 * ONE schedule phrasing. `cronWords` phrases ANY stored cron the grammar
 * round-trips; `CRON_RECURRENCES` label the closed set the composers offer.
 * For every offered recurrence the two must say the same words. Derived from
 * the shared list, never hand-listed.
 */
describe("cronWords ⇄ the shared recurrences", () => {
  it("names every offered recurrence exactly as its shared label", () => {
    expect(CRON_RECURRENCES.length).toBeGreaterThanOrEqual(4);
    for (const r of CRON_RECURRENCES) {
      expect(cronWords(cronExpressionOf(r.trigger)), r.id).toBe(r.label);
    }
  });

  it("refuses a step it would misread instead of a confident wrong sentence", () => {
    expect(cronWords("*/15 * * * *")).toBeNull();
  });
});

describe("the ONE WHEN / THEN phrasing", () => {
  it("phrases a first-party event in the past mood with its article", () => {
    expect(eventPatternWhenText("entity.create.completed", ["invoice"])).toBe(
      "An invoice was created"
    );
    expect(eventPatternWhenText("task.*", [])).toBe("Any task activity");
  });

  it("phrases a THEN imperatively", () => {
    expect(actionPhrase("create", "report")).toBe("Create a report");
  });

  it("a stored event rule reads through the same phrasing", () => {
    const words = ruleWhenWords("event", {
      eventPattern: "entity.create.completed",
      profileSlug: "person",
    });
    expect(words.text).toBe(
      eventPatternWhenText("entity.create.completed", ["person"])
    );
    expect(words.watches).toEqual(["person"]);
    expect(words.text).toContain(words.noun!);
  });

  it("a stored schedule, manual, and record THEN never leak a token", () => {
    expect(ruleWhenWords("cron", { expression: "0 9 * * *" }).text).toBe(
      "Every day at 09:00 UTC"
    );
    expect(ruleWhenWords("manual", {}).text).toBe("When you run it");
    const then = ruleThenWords(
      {
        nodes: [
          {
            type: "output",
            data: {
              outputType: "entity_create",
              config: { profileSlug: "report" },
            },
          },
        ],
      },
      new Map()
    );
    expect(then.text).toBe(actionPhrase("create", "report"));
  });
});

describe("stored narrowing reads through the composers' clause builder", () => {
  it("reads every operator the writer emits back (not '[object Object]')", () => {
    const rows = flowToConditions({
      filters: {
        deadline: { $within: "today" },
        title: { $contains: "urgent" },
        name: { $starts_with: "Ac" },
        stage: { $eq: "won" },
      },
    });
    expect(rows.map((r) => [r.operator, r.value])).toEqual([
      ["is_within", "today"],
      ["contains", "urgent"],
      ["starts_with", "Ac"],
      ["is", "won"],
    ]);
  });

  it("Only-if clauses carry the field, the comparison and the value", () => {
    const words = ruleWhenWords("event", {
      eventPattern: "entity.update.completed",
      filters: {
        profileSlug: "deal",
        amount: { $gt: "500" },
        "changed.stage": true,
        owner: { $ne: null },
        tier: { $in: ["gold", "silver"] },
      },
    });
    expect(words.onlyIf).toEqual([
      "Amount greater than 500",
      "Stage changed",
      "Owner is set",
      "Tier is gold or silver",
    ]);
    expect(words.onlyIf.join(" ")).not.toContain("[object Object]");
  });
});
