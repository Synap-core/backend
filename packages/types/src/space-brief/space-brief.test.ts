import { describe, it, expect } from "vitest";
import {
  SPACE_BRIEF_APPLIER_OWNED_FIELDS,
  SPACE_BRIEF_PRECEDENCE,
  SPACE_BRIEF_PRECEDENCE_NOTE,
  SPACE_BRIEF_TEMPLATE_FIELDS,
  SPACE_SKILL_MODES,
  applySpaceBriefPatch,
  briefPurpose,
  diffSpaceBrief,
  isInterviewBrief,
  isSpaceSkillMode,
  readSpaceBrief,
  resolveAuthoredDescription,
  resolveSpacePurpose,
  validateSpaceSkillDeclaration,
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
        skills: [{ slug: "system/synap/creative-director", mode: "always" }],
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

describe("validateSpaceSkillDeclaration — the skill a space declares", () => {
  const good = [
    { slug: "system/synap/creative-director", mode: "always" },
    { slug: "system/synap-schema/extend-first", mode: "on-demand" },
    // A bare stem resolves too (load_skill accepts one), so both are valid.
    { slug: "creative-director", mode: "always" },
    { slug: "biz/business-plan", mode: "on-demand" },
    // `when` is surfaced prose, never parsed — free text is fine.
    { slug: "x", mode: "always", when: "any content ask — carousel, deck" },
  ] as const;

  for (const skill of good) {
    it(`accepts ${JSON.stringify(skill.slug)} / ${skill.mode}`, () => {
      expect(validateSpaceSkillDeclaration(skill)).toBeNull();
    });
  }

  // Each row names the ONE thing wrong; the message must mention the value or
  // the mode so an author can act without reading this file.
  const bad: Array<[string, unknown, RegExp]> = [
    [
      "uppercase",
      { slug: "System/Synap/Creative-Director", mode: "always" },
      /not a valid skill slug/,
    ],
    [
      "whitespace",
      { slug: "system/synap/creative director", mode: "always" },
      /not a valid skill slug/,
    ],
    ["empty", { slug: "", mode: "always" }, /non-empty `slug`/],
    ["missing slug", { mode: "always" }, /non-empty `slug`/],
    [
      "leading slash",
      { slug: "/system/synap/x", mode: "always" },
      /not a valid skill slug/,
    ],
    [
      "trailing slash",
      { slug: "system/synap/", mode: "always" },
      /not a valid skill slug/,
    ],
    [
      "empty segment",
      { slug: "system//creative-director", mode: "always" },
      /not a valid skill slug/,
    ],
    ["too deep", { slug: "a/b/c/d", mode: "always" }, /not a valid skill slug/],
    [
      "unknown mode",
      { slug: "system/synap/x", mode: "sometimes" },
      /`mode` must be one of/,
    ],
    ["missing mode", { slug: "system/synap/x" }, /`mode` must be one of/],
    ["not an object", "system/synap/x", /must be an object/],
  ];

  for (const [label, skill, pattern] of bad) {
    it(`rejects ${label}`, () => {
      const reason = validateSpaceSkillDeclaration(skill);
      expect(
        reason,
        "a malformed declaration must be rejected, not tolerated"
      ).not.toBeNull();
      expect(reason).toMatch(pattern);
    });
  }

  it("the mode vocabulary is closed and shared", () => {
    expect(SPACE_SKILL_MODES).toEqual(["always", "on-demand"]);
    expect(isSpaceSkillMode("always")).toBe(true);
    expect(isSpaceSkillMode("on-demand")).toBe(true);
    expect(isSpaceSkillMode("sometimes")).toBe(false);
    expect(isSpaceSkillMode(undefined)).toBe(false);
  });
});

describe("the brief KEEPS the space's declared skills (stored JSONB is data)", () => {
  const read = (skills: unknown) =>
    readSpaceBrief({ onboarding: { purpose: "p", skills } });

  it("round-trips a well-formed declaration, when included", () => {
    const brief = read([
      {
        slug: "system/synap/creative-director",
        mode: "always",
        when: "any content ask",
      },
    ]);
    expect(brief?.skills).toEqual([
      {
        slug: "system/synap/creative-director",
        mode: "always",
        when: "any content ask",
      },
    ]);
  });

  it("DROPS a malformed row rather than half-trusting it", () => {
    // A hand-edited brief must not smuggle in a mode the loader has never heard
    // of, nor a slug no skill could match — the same rule the authoring
    // validator enforces. The well-formed row beside it still survives.
    const brief = read([
      { slug: "system/synap/creative-director", mode: "always" },
      { slug: "Not A Slug", mode: "always" },
      { slug: "system/synap/x", mode: "sometimes" },
      { mode: "always" },
      "nonsense",
    ]);
    expect(brief?.skills).toEqual([
      { slug: "system/synap/creative-director", mode: "always" },
    ]);
  });

  it("an array whose every row is malformed reads as ABSENT, not as []", () => {
    const brief = read([{ slug: "System/X", mode: "always" }]);
    expect(brief).not.toBeNull();
    expect("skills" in brief!).toBe(false);
  });

  it("a brief with no skills key exposes none", () => {
    expect(read(undefined)?.skills).toBeUndefined();
  });
});
