/**
 * `parseRuleText` — the text→rule door behind `skills.parseRule` and
 * `POST /rules/parse`. Driven through the REAL shared matcher and the REAL
 * `compileRuleSentence`; only the IS leg is injected.
 *
 * What it pins:
 *   - the matcher answers alone when it fills both halves (the IS is NOT asked);
 *   - the IS is asked only for the open half, with the pod's own labels, and
 *     only its in-vocabulary picks reach the sentence;
 *   - a dead IS is `aiUnavailable` + the matcher's reading — never empty;
 *   - a complete sentence is compiled (validation ok) and never saved.
 */
import { describe, expect, it, vi } from "vitest";

import type { ActionOption, EventOption } from "../../routers/automations.js";
import {
  parseRuleText,
  type AskIsParseRule,
  type IsParseRuleAnswer,
  type ParseRuleVocabulary,
} from "./parse-text.js";

const events: EventOption[] = [
  {
    pattern: "entity.created",
    label: "An entity was created",
    source: "catalog",
  },
  {
    pattern: "external_message.received",
    label: "A message arrived",
    source: "catalog",
    filterKeys: ["platform", "sender"],
  },
];
const actions: ActionOption[] = [
  {
    key: "notification",
    label: "Send a notification",
    nodeType: "output",
    outputType: "notification",
  },
  {
    key: "playbook:qualify",
    label: "Run Qualify a lead",
    nodeType: "playbook_run",
    playbookId: "11111111-1111-4111-8111-111111111111",
  },
];
const VOCAB: ParseRuleVocabulary = {
  events,
  actions,
  kinds: [{ slug: "person", label: "Person" }],
};

const answer = (
  s: Partial<IsParseRuleAnswer["sentence"]>
): IsParseRuleAnswer => ({
  sentence: {
    eventPattern: null,
    scheduleId: null,
    kind: null,
    conditions: [],
    actionKeys: [],
    ...s,
  },
});

describe("parseRuleText", () => {
  it("the matcher alone: both halves filled ⇒ the IS is not asked, the sentence compiles", async () => {
    const askIs = vi.fn<AskIsParseRule>();
    const out = await parseRuleText(
      "when an entity is created, send a notification",
      VOCAB,
      askIs
    );
    expect(askIs).not.toHaveBeenCalled();
    expect(out.source).toBe("matcher");
    expect(out.picks.eventPattern).toBe("entity.created");
    expect(out.picks.actionKeys).toEqual(["notification"]);
    expect(out.unresolved).toEqual([]);
    expect(out.validation).toEqual({ ok: true });
    expect(out.sentence.actions).toHaveLength(1);
  });

  it("asks the IS only for the open half, with the pod's labels, and keeps the matcher's half", async () => {
    const askIs = vi.fn<AskIsParseRule>(async () =>
      answer({
        eventPattern: "entity.created",
        kind: "person",
        actionKeys: ["playbook:qualify"],
      })
    );
    const out = await parseRuleText(
      "when a person is added in CRM, send a notification",
      VOCAB,
      askIs
    );
    expect(askIs).toHaveBeenCalledTimes(1);
    const req = askIs.mock.calls[0]![0];
    expect(req.vocabulary.events).toContainEqual({
      pattern: "entity.created",
      label: "An entity was created",
    });
    expect(req.vocabulary.kinds).toEqual([{ slug: "person", label: "Person" }]);
    expect(req.vocabulary.schedules.length).toBeGreaterThan(0);
    expect(req.resolved).toEqual({ actionKeys: ["notification"] });
    expect(out.source).toBe("ai");
    // The matcher's THEN stands; the AI's extra pick does not replace it.
    expect(out.picks.actionKeys).toEqual(["notification"]);
    expect(out.picks.kind).toBe("person");
    expect(out.sentence.trigger).toMatchObject({
      triggerType: "event",
      subjectCategory: "entity",
      actionVerb: "created",
      profileSlug: "person",
    });
    expect(out.validation).toEqual({ ok: true });
  });

  it("an off-vocabulary AI pick never reaches the sentence", async () => {
    const out = await parseRuleText("zzz qqq", VOCAB, async () =>
      answer({
        eventPattern: "deal.won",
        actionKeys: ["send_sms"],
        kind: "unicorn",
      })
    );
    expect(out.sentence.trigger).toBeNull();
    expect(out.sentence.actions).toEqual([]);
    expect(out.picks.kind).toBeNull();
    expect(out.unresolved.map((g) => g.slot)).toEqual(["trigger", "actions"]);
    // Nothing the AI said was usable, so the reading is still the matcher's.
    expect(out.source).toBe("matcher");
    expect(out.validation).toBeNull();
  });

  it("a dead IS is aiUnavailable with the matcher's reading — never an empty parse", async () => {
    const out = await parseRuleText(
      "when an entity is created, frobnicate",
      VOCAB,
      async () => {
        throw new Error("IS parse-rule answered 503");
      }
    );
    expect(out.aiUnavailable).toBe(true);
    expect(out.source).toBe("matcher");
    expect(out.picks.eventPattern).toBe("entity.created");
    expect(out.warnings.join(" ")).toMatch(/could not read/i);
    expect(out.unresolved.map((g) => g.slot)).toEqual(["actions"]);
  });

  it("a narrowing on an event filter key becomes a WHERE row; an unknown field is reported, not dropped", async () => {
    const out = await parseRuleText(
      "a message arrived where platform is telegram and mood is happy, send a notification",
      VOCAB,
      vi.fn<AskIsParseRule>()
    );
    expect(out.sentence.conditions).toEqual([
      { id: "platform", key: "platform", operator: "is", value: "telegram" },
    ]);
    expect(out.unresolved).toContainEqual(
      expect.objectContaining({ slot: "condition", field: "mood" })
    );
    expect(out.picks.clauses.map((c) => c.field)).toEqual(["platform", "mood"]);
  });

  it("an AI condition with an unknown operator is ignored with a warning", async () => {
    const out = await parseRuleText("zzz", VOCAB, async () =>
      answer({
        eventPattern: "external_message.received",
        actionKeys: ["notification"],
        conditions: [{ field: "sender", operator: "resembles", value: "bob" }],
      })
    );
    expect(out.sentence.conditions).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/unknown comparison/);
    expect(out.validation).toEqual({ ok: true });
  });
});
