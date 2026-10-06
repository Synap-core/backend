/**
 * MOVED HERE from relay-app (`rule-compose/__tests__/rule-text-match.test.ts`)
 * is relay's (`rule-text-summary.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  ruleTextTokens,
  labelCoverage,
  splitRuleText,
  matchRuleText,
  matchGap,
  MATCH_THRESHOLD,
} from "./rule-text-match.js";

/** The pod's option shapes, structurally — the matcher reads only label/pattern. */
interface EventOption {
  pattern: string;
  label: string;
  source: string;
  observedCount?: number;
}
interface ActionOption {
  key: string;
  label: string;
  nodeType: string;
  outputType?: string;
}

/**
 * Labels shaped like the ones the pod's own doors return — `eventLabelFor` /
 * `actionLabelFor` produce sentence-cased prose, and the collision that makes
 * the WHEN/THEN split necessary ("notification" on both sides) is real.
 */
const events: EventOption[] = [
  {
    pattern: "entity.created",
    label: "An entity was created",
    source: "catalog",
  },
  {
    pattern: "notification.received",
    label: "A notification was received",
    source: "catalog",
  },
  {
    pattern: "capture.completed",
    label: "A capture was completed",
    source: "observed",
    observedCount: 9,
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
    key: "entity_create",
    label: "Create an entity",
    nodeType: "output",
    outputType: "entity_create",
  },
  {
    key: "call_webhook",
    label: "Call a webhook",
    nodeType: "output",
    outputType: "call_webhook",
  },
];

const vocab = { events, actions };

describe("ruleTextTokens", () => {
  it("drops filler and punctuation, keeps domain words", () => {
    expect(
      ruleTextTokens("As soon as an invoice is created, notify me!")
    ).toEqual(["invoice", "created", "notify"]);
  });

  it('keeps "new" — it is the only word distinguishing a new note from a note', () => {
    expect(ruleTextTokens("a new note")).toEqual(["new", "note"]);
  });
});

describe("labelCoverage", () => {
  it("is 1 when every content word of the label was said", () => {
    expect(
      labelCoverage(
        "An entity was created",
        ruleTextTokens("when an entity is created")
      )
    ).toBe(1);
  });

  it("is partial when only some were said", () => {
    expect(
      labelCoverage("Send a notification", ruleTextTokens("send something"))
    ).toBeCloseTo(0.5);
  });

  it("is 0 for a label with no content words of its own", () => {
    // Otherwise a pure-filler label would match every sentence ever typed.
    expect(labelCoverage("it is the", ruleTextTokens("anything at all"))).toBe(
      0
    );
  });
});

describe("splitRuleText", () => {
  it("splits on a comma", () => {
    const halves = splitRuleText(
      "when an entity is created, send a notification"
    );
    expect(halves.split).toBe(true);
    expect(halves.when).toContain("entity");
    expect(halves.then).toContain("notification");
    expect(halves.when).not.toContain("notification");
  });

  it('splits on "then"', () => {
    expect(
      splitRuleText("an entity was created then create an entity").then.trim()
    ).toBe("create an entity");
  });

  it("scores both halves against the whole text when there is no connective", () => {
    const halves = splitRuleText("an entity was created send a notification");
    expect(halves.split).toBe(false);
    expect(halves.when).toBe(halves.then);
  });
});

describe("matchRuleText", () => {
  it("fills both halves from one typed sentence", () => {
    const m = matchRuleText(
      "when an entity is created, send a notification",
      vocab
    );
    expect(m.trigger?.pattern).toBe("entity.created");
    expect(m.actions.map((a) => a.key)).toEqual(["notification"]);
    expect(matchGap(m)).toBeNull();
  });

  it("does not let the THEN half steal the WHEN half’s words", () => {
    // "notification" is in an event label AND an action label. Without the
    // split, "send a notification" alone would also match the RECEIVED event.
    const m = matchRuleText(
      "when an entity is created, send a notification",
      vocab
    );
    expect(m.trigger?.pattern).not.toBe("notification.received");
  });

  it("keeps several actions in the order they were said", () => {
    const m = matchRuleText(
      "when an entity is created, create an entity and send a notification",
      vocab
    );
    expect(m.actions.map((a) => a.key)).toEqual([
      "entity_create",
      "notification",
    ]);
  });

  it("refuses a one-word accident below the threshold", () => {
    // "create" alone covers 1 of the 2 content words in "Create an entity".
    expect(
      labelCoverage("Create an entity", ruleTextTokens("create"))
    ).toBeLessThan(MATCH_THRESHOLD);
    const m = matchRuleText("create", vocab);
    expect(m.actions).toEqual([]);
  });

  it("reports the missing half rather than guessing at it", () => {
    const m = matchRuleText("when an entity is created", vocab);
    expect(m.trigger?.pattern).toBe("entity.created");
    expect(matchGap(m)).toBe("actions");
  });

  it("reports both halves missing for text the vocabulary does not cover", () => {
    const m = matchRuleText(
      "remind my accountant about the quarterly filing",
      vocab
    );
    expect(matchGap(m)).toBe("both");
  });

  it("has not attempted anything on empty text, and says nothing about it", () => {
    const m = matchRuleText("   ", vocab);
    expect(m.attempted).toBe(false);
    expect(matchGap(m)).toBeNull();
  });

  it("never invents an option the pod did not return", () => {
    const m = matchRuleText(
      "when an entity is created, send a notification",
      vocab
    );
    for (const a of m.actions) expect(actions).toContain(a);
    if (m.trigger) expect(events).toContain(m.trigger);
  });
});

/**
 * AN EMPTY VOCABULARY IS NOT A FAILED MATCH.
 *
 * When the pod returns no events and no actions there was no list to score
 * against, so "nothing matched" is a statement about the POD, not about what
 * the user typed. The generic gap line tells them to "pick from the list" — an
 * instruction pointing at an empty list, which is a control that does nothing
 * wearing the shape of copy.
 */
describe("an empty vocabulary degrades to a true sentence", () => {
  const none = { events: [], actions: [] };

  it("leaves BOTH halves open rather than reading as understood-and-nothing-to-do", () => {
    const m = matchRuleText("when an invoice is created, notify me", none);
    expect(m.trigger).toBeNull();
    expect(m.actions).toEqual([]);
    expect(matchGap(m)).toBe("both");
  });

  it("flags an empty pod vocabulary, distinct from a vocabulary that matched nothing", () => {
    // Surfaces word the two differently (an empty pod must not be told to pick
    // from a list); the matcher's job is to keep them distinguishable.
    expect(
      matchRuleText("when an invoice is created, notify me", none)
        .vocabularyEmpty
    ).toBe(true);
    const m = matchRuleText("remind my accountant", vocab);
    expect(m.vocabularyEmpty).toBe(false);
    expect(matchGap(m)).toBe("both");
  });
});

describe("a comma may never empty the card", () => {
  /**
   * `splitRuleText` cuts on the first connective, which suits "when X, notify
   * me". Reversed English — "notify me, when an invoice is created" — puts the
   * ACTION in the WHEN half and the TRIGGER in the THEN half, so both sides
   * scored zero and BOTH chips vanished the instant the comma was typed, after
   * matching fine while the same words were unpunctuated.
   *
   * A user cannot know which half the parser calls which. The split is now a
   * hypothesis: if it finds strictly less than the unsplit text, the unsplit
   * reading wins.
   */
  const vocab = {
    events: [
      { pattern: "entity.create.completed", label: "An invoice was created" },
    ],
    actions: [{ key: "notify", label: "Notify me" }],
  } as unknown as Parameters<typeof matchRuleText>[1];

  it("matches reversed order WITHOUT the comma", () => {
    const m = matchRuleText("notify me when an invoice is created", vocab);
    expect(m.trigger).not.toBeNull();
    expect(m.actions.length).toBe(1);
  });

  it("still matches reversed order WITH the comma — the regression", () => {
    const m = matchRuleText("notify me, when an invoice is created", vocab);
    expect(m.trigger, "the comma must not lose the trigger").not.toBeNull();
    expect(m.actions.length, "the comma must not lose the action").toBe(1);
  });

  it("the normal order still splits — the fallback must not disable the split", () => {
    // If the fallback fired always, "notify me" in the WHEN half would let a
    // trigger-shaped phrase match an action and vice versa. The split still
    // runs whenever it finds something.
    const m = matchRuleText("when an invoice is created, notify me", vocab);
    expect(m.trigger).not.toBeNull();
    expect(m.actions.length).toBe(1);
  });
});
