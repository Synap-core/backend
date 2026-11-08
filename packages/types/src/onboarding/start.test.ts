import { describe, it, expect } from "vitest";
import {
  buildGetStartedPrompt,
  completedStartPrefix,
  deriveStartSteps,
  nextStartStep,
  resolveKindView,
  START_STEP_IDS,
  type StartFacts,
} from "./start.js";
import { UIPreferencesSchema } from "../preferences/schemas.js";

const T = "2026-10-28T10:00:00.000Z";

const base: StartFacts = {
  values: null,
  waysIn: 0,
  journeyStatus: null,
};
const f = (o: Partial<StartFacts>): StartFacts => ({ ...base, ...o });
const done = (facts: StartFacts) =>
  deriveStartSteps(facts)
    .filter((s) => s.done)
    .map((s) => s.id);

const intent = { slug: "sales", source: "here" as const, at: T };

describe("deriveStartSteps (§2.2 table)", () => {
  it("pod admin's journey is intent, access, defaults, done (founder, 7 Nov 2026)", () => {
    expect([...START_STEP_IDS]).toEqual([
      "start:intent",
      "start:access",
      "start:defaults",
      "start:done",
    ]);
  });

  it("1. empty facts: nothing done, next is intent", () => {
    const s = deriveStartSteps(base);
    expect(s.map((x) => x.id)).toEqual([...START_STEP_IDS]);
    expect(done(base)).toEqual([]);
    expect(nextStartStep(s)).toBe("start:intent");
  });

  it("2. intent set marks intent only; next is the secure-access step", () => {
    const facts = f({ values: { v: 1, intent } });
    expect(done(facts)).toEqual(["start:intent"]);
    expect(nextStartStep(deriveStartSteps(facts))).toBe("start:access");
  });

  it("3. access: one way in is not enough; two ways in are, with nothing recorded", () => {
    const one = f({ values: { v: 1, intent }, waysIn: 1 });
    expect(done(one)).not.toContain("start:access");
    const two = f({ values: { v: 1, intent }, waysIn: 2 });
    expect(done(two)).toContain("start:access");
    expect(nextStartStep(deriveStartSteps(two))).toBe("start:defaults");
  });

  it("4. access: going past it (Skip for now) marks it, whatever the count", () => {
    expect(
      done(f({ values: { v: 1, access: { at: T } }, waysIn: 0 }))
    ).toContain("start:access");
  });

  it("5. access: a failed count (null) never marks it done", () => {
    expect(done(f({ waysIn: null }))).not.toContain("start:access");
  });

  it("6. defaults: done once the owner went past it; next is done", () => {
    const facts = f({
      values: { v: 1, intent, access: { at: T }, defaults: { at: T } },
    });
    expect(done(facts)).toEqual([
      "start:intent",
      "start:access",
      "start:defaults",
    ]);
    expect(nextStartStep(deriveStartSteps(facts))).toBe("start:done");
  });

  it("7. done follows the journey's status", () => {
    const all = f({
      values: { v: 1, intent, access: { at: T }, defaults: { at: T } },
      journeyStatus: "completed",
    });
    expect(done(all)).toEqual([...START_STEP_IDS]);
    expect(nextStartStep(deriveStartSteps(all))).toBeNull();
  });

  it("completedStartPrefix stops at the first gap", () => {
    const steps = deriveStartSteps(
      f({ values: { v: 1, intent, defaults: { at: T } }, waysIn: 1 })
    );
    expect(completedStartPrefix(steps)).toEqual(["start:intent"]);
  });
});

describe("resolveKindView (pref, then space default, then template first)", () => {
  const templateViews = [
    { slug: "deal-pipeline", type: "kanban" },
    { slug: "deals-table", type: "table" },
  ];
  const pref = {
    view: "deals-table",
    type: "table",
    at: T,
    source: "settings" as const,
  };

  it("pref wins", () => {
    expect(
      resolveKindView({ pref, templateViews, spaceDefault: "deal-pipeline" })
    ).toEqual({ view: "deals-table", type: "table", from: "pref" });
  });
  it("space default beats template first", () => {
    expect(
      resolveKindView({
        pref: null,
        templateViews,
        spaceDefault: "deals-table",
      })
    ).toMatchObject({ view: "deals-table", from: "space-default" });
  });
  it("template first is the last resort", () => {
    expect(
      resolveKindView({ pref: undefined, templateViews, spaceDefault: null })
    ).toMatchObject({ view: "deal-pipeline", from: "template-first" });
  });
  it("a stale pref falls through; no views gives null", () => {
    expect(
      resolveKindView({
        pref: { ...pref, view: "gone" },
        templateViews,
        spaceDefault: null,
      })
    ).toMatchObject({ from: "template-first" });
    expect(
      resolveKindView({ pref: null, templateViews: [], spaceDefault: null })
    ).toBeNull();
  });
});

describe("buildGetStartedPrompt", () => {
  it("returns the exact spec string", () => {
    expect(
      buildGetStartedPrompt({
        sessionTitle: "Your live deals",
        sessionId: "a1b2c3d4-0000-4000-8000-000000000000",
      })
    ).toBe(
      'Use Synap. Get started with Synap: open my session "Your live deals" (a1b2c3d4) and do its first step. Ask me before you keep anything.'
    );
  });
});

describe("UIPreferencesSchema", () => {
  it("keeps kindViews (a zod object strips unknown keys)", () => {
    const kindViews = {
      deal: {
        view: "deal-pipeline",
        type: "kanban",
        at: T,
        source: "onboarding",
      },
    };
    expect(UIPreferencesSchema.parse({ kindViews })?.kindViews).toEqual(
      kindViews
    );
  });
});
