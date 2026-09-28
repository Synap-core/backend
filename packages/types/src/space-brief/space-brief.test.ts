import { describe, it, expect } from "vitest";
import {
  SPACE_BRIEF_APPLIER_OWNED_FIELDS,
  SPACE_BRIEF_PRECEDENCE,
  SPACE_BRIEF_PRECEDENCE_NOTE,
  SPACE_BRIEF_TEMPLATE_FIELDS,
  applySpaceBriefPatch,
  briefPurpose,
  diffSpaceBrief,
  isInterviewBrief,
  readSpaceBrief,
  resolveAuthoredDescription,
  resolveSpacePurpose,
  type SpaceBrief,
} from "./index.js";

/** The shape brand-library installs today — the legacy interview brief. */
const LEGACY = {
  goal: "Capture the brand's expressive DNA",
  framing: "THE BRAND STRATEGIST",
  expertise: { starters: ["pairs"], bar: "a stranger could write it" },
  collect: [
    {
      profileSlug: "brand-identity",
      what: "The core identity",
      cardinality: "one",
    },
  ],
  openingQuestions: ["How should it sound?"],
  doneWhen: "identity + voice",
};

describe("readSpaceBrief — the ONE reader", () => {
  it("reads a legacy onboarding spec VALUE-for-value", () => {
    expect(readSpaceBrief({ onboarding: LEGACY })).toEqual(LEGACY);
  });

  it("no brief is null; an unreadable brief is an EMPTY brief, not null", () => {
    expect(readSpaceBrief({})).toBeNull();
    expect(readSpaceBrief(null)).toBeNull();
    expect(readSpaceBrief({ onboarding: "x" })).toBeNull();
    expect(
      readSpaceBrief({ onboarding: { goal: "   ", collect: [{}] } })
    ).toEqual({});
  });

  it("reads the steady-state fields and drops malformed parts", () => {
    const b = readSpaceBrief({
      onboarding: {
        purpose: "  Store the brand  ",
        anchors: [
          {
            profileSlug: "brand-identity",
            role: "root",
            seedRef: "Brand",
            limit: 1,
          },
          { profileSlug: "", role: "root" },
          { profileSlug: "brand-rule", role: "bogus", limit: -2 },
        ],
        rules: [{ key: "assets-first", ruleId: "r1" }, { ruleId: "orphan" }],
        fetch: [{ query: "logo" }, { note: "nothing to fetch" }],
        collect: [
          { profileSlug: "brand-rule", what: "Rules", min: 1 },
          { profileSlug: "x", min: 0 },
        ],
      },
    });
    expect(b).toEqual({
      purpose: "Store the brand",
      anchors: [
        {
          profileSlug: "brand-identity",
          role: "root",
          seedRef: "Brand",
          limit: 1,
        },
        { profileSlug: "brand-rule", role: "context" },
      ],
      rules: [{ key: "assets-first", ruleId: "r1" }],
      fetch: [{ query: "logo" }],
      collect: [
        { profileSlug: "brand-rule", what: "Rules", min: 1 },
        { profileSlug: "x", what: "" },
      ],
    } satisfies SpaceBrief);
  });

  it("interview mode is the goal/questions/doneWhen fields", () => {
    expect(isInterviewBrief(readSpaceBrief({ onboarding: LEGACY }))).toBe(true);
    expect(isInterviewBrief({ purpose: "p", framing: "f" })).toBe(false);
    expect(isInterviewBrief(null)).toBe(false);
  });

  it("purpose falls back to the interview goal", () => {
    expect(briefPurpose({ purpose: "p", goal: "g" })).toBe("p");
    expect(briefPurpose({ goal: "g" })).toBe("g");
    expect(briefPurpose({})).toBeNull();
  });
});

describe("field classification (non-vacuity)", () => {
  it("every brief field is classified exactly once", () => {
    const all = [
      ...SPACE_BRIEF_TEMPLATE_FIELDS,
      ...SPACE_BRIEF_APPLIER_OWNED_FIELDS,
    ];
    expect(new Set(all).size).toBe(all.length);
    // A fully-populated brief uses every classified key and nothing else.
    const full = readSpaceBrief({
      onboarding: {
        ...LEGACY,
        purpose: "p",
        anchors: [{ profileSlug: "k", role: "root" }],
        rules: [{ key: "r" }],
        fetch: [{ query: "q" }],
      },
    })!;
    expect(Object.keys(full).sort()).toEqual([...all].sort());
  });

  it("precedence is stated highest first, floors on top, persona last", () => {
    expect(SPACE_BRIEF_PRECEDENCE[0]).toBe("governance floors");
    expect(SPACE_BRIEF_PRECEDENCE.at(-1)).toBe("template persona");
    expect(SPACE_BRIEF_PRECEDENCE_NOTE).toContain(
      "project rule > space rule > pod rule"
    );
  });
});

describe("applySpaceBriefPatch / diffSpaceBrief", () => {
  it("replaces, removes with null, leaves absent keys alone", () => {
    const before = readSpaceBrief({ onboarding: LEGACY })!;
    const after = applySpaceBriefPatch(before, {
      purpose: "Brand source of truth",
      doneWhen: null,
    });
    expect(after.purpose).toBe("Brand source of truth");
    expect(after.doneWhen).toBeUndefined();
    expect(after.framing).toBe(LEGACY.framing);
    expect(diffSpaceBrief(before, after)).toEqual([
      { field: "purpose", after: "Brand source of truth" },
      { field: "doneWhen", before: "identity + voice" },
    ]);
  });

  it("a patch cannot touch applier-owned rule refs", () => {
    const after = applySpaceBriefPatch(
      { rules: [{ key: "k" }] },
      {
        // @ts-expect-error rules is not patchable
        rules: null,
      }
    );
    expect(after.rules).toEqual([{ key: "k" }]);
  });

  it("key order does not read as a change", () => {
    expect(
      diffSpaceBrief(
        { expertise: { bar: "b", starters: ["s"] } },
        { expertise: { starters: ["s"], bar: "b" } }
      )
    ).toEqual([]);
  });
});

describe("resolveSpacePurpose — THE purpose ladder", () => {
  // Rows chosen where the candidate orders DISAGREE (description vs purpose
  // vs goal), so each rules one alternative out.
  const cases: Array<[unknown, unknown, string | null]> = [
    ["Authored.", { onboarding: { purpose: "P", goal: "G" } }, "Authored."],
    ["  Domain: personal ", { onboarding: { purpose: "P", goal: "G" } }, "P"],
    [null, { onboarding: { purpose: "P", goal: "G" } }, "P"],
    [undefined, { onboarding: { goal: "G" } }, "G"],
    ["   ", { onboarding: { purpose: "   ", goal: "G" } }, "G"],
    [42, null, null],
  ];
  for (const [description, settings, want] of cases) {
    it(`${JSON.stringify(description)} + ${JSON.stringify(settings)} → ${want}`, () => {
      expect(resolveSpacePurpose({ description, settings })).toBe(want);
    });
  }

  it("the placeholder check is the description's only filter", () => {
    expect(resolveAuthoredDescription(" Real ")).toBe("Real");
    expect(resolveAuthoredDescription("domain: crm")).toBeNull();
    expect(resolveAuthoredDescription("Domain: the CRM space")).toBe(
      "Domain: the CRM space"
    );
  });
});

