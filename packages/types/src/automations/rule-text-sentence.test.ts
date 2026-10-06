import { describe, expect, it } from "vitest";
import { sentenceFromTextMatch } from "./rule-text-sentence.js";

const created = {
  pattern: "entity.create.completed",
  label: "A task was created",
  profileSlug: "task",
  filterKeys: ["status"],
};

describe("sentenceFromTextMatch — one builder for the composer and the parse door", () => {
  it("builds the WHEN from the event option, keeping its kind", () => {
    const { sentence } = sentenceFromTextMatch({
      event: created,
      objectSegment: null,
      actions: [],
      clauses: [],
    });
    expect(sentence.trigger).toMatchObject({
      triggerType: "event",
      profileSlug: "task",
    });
  });

  it("an object with no verb lands on `<object>.*`", () => {
    const { sentence } = sentenceFromTextMatch({
      event: null,
      objectSegment: "task",
      actions: [],
      clauses: [],
    });
    expect(sentence.trigger).not.toBeNull();
    expect(sentence.trigger!.actionVerb).toBeFalsy();
  });

  it("a clause on a narrowable key is a row; any other is REPORTED, not dropped", () => {
    const { sentence, unresolvedClauses } = sentenceFromTextMatch({
      event: created,
      objectSegment: null,
      actions: [],
      clauses: [
        { field: "status", operator: "is", value: "open" },
        { field: "deadline", operator: "is_within", value: "today" },
      ],
    });
    expect(sentence.conditions).toEqual([
      { id: "status", key: "status", operator: "is", value: "open" },
    ]);
    expect(unresolvedClauses.map((c) => c.field)).toEqual(["deadline"]);
  });

  it("a clause that restates the WHEN is not a narrowing", () => {
    const { sentence, unresolvedClauses } = sentenceFromTextMatch({
      event: created,
      objectSegment: null,
      actions: [],
      clauses: [{ field: "task", operator: "is", value: "created, notify me" }],
    });
    expect(sentence.conditions).toEqual([]);
    expect(unresolvedClauses).toEqual([]);
  });

  it("a kind binds only a GENERIC entity trigger", () => {
    const generic = sentenceFromTextMatch({
      event: { ...created, profileSlug: null },
      objectSegment: null,
      kind: "person",
      actions: [],
      clauses: [],
    });
    expect(generic.sentence.trigger).toMatchObject({ profileSlug: "person" });
    const bound = sentenceFromTextMatch({
      event: created,
      objectSegment: null,
      kind: "person",
      actions: [],
      clauses: [],
    });
    expect(bound.sentence.trigger).toMatchObject({ profileSlug: "task" });
  });

  it("half-declared THEN options are refused, full ones built", () => {
    const { sentence } = sentenceFromTextMatch({
      event: created,
      objectSegment: null,
      actions: [
        { key: "notify", nodeType: "output", outputType: "notification" },
        { key: "pb", nodeType: "playbook_run" },
      ],
      clauses: [],
    });
    expect(sentence.actions).toHaveLength(1);
  });
});
