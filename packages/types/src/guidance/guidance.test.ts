import { describe, expect, it } from "vitest";
import {
  GUIDANCE_BUDGET_TOKENS,
  GUIDANCE_HEADING,
  GUIDANCE_ORDERED_SENTENCE,
  MAX_GUIDANCE_ITEMS,
  parseGuidanceRef,
  renderGuidance,
  validateGuidanceDeclaration,
  validateGuidanceList,
  type GuidanceRow,
  type ResolvedGuidance,
} from "./index.js";

const field = (
  key: string,
  label: string,
  value: string,
  position: number
) => ({
  key,
  label,
  value,
  position,
});

const VOICE: ResolvedGuidance = {
  declaration: {
    ref: "kind:brand-voice-guide",
    label: "Voice",
    where: { "voice-context": ["general", "outreach"] },
  },
  rows: [
    {
      id: "v-1",
      title: "Outreach voice",
      version: "3",
      order: null,
      fields: [
        field("voice-tone-descriptors", "Tone", "warm, direct", 1),
        field("voice-example-do", "Do", "Cite the signal.\nKeep it short.", 2),
        field("voice-example-dont", "Don't", "Say synergy.", 3),
      ],
    },
  ],
};

const ANGLES: ResolvedGuidance = {
  declaration: { ref: "kind:outreach-angle", label: "By kind of lead" },
  rows: [
    {
      id: "a-2",
      title: "Default",
      version: "1",
      order: 2,
      fields: [field("lead-with", "Lead with", "A question", 1)],
    },
    {
      id: "a-1",
      title: "Posted on Malt",
      version: "4",
      order: 1,
      fields: [
        field("when", "When", "posted an automation project", 0),
        field("lead-with", "Lead with", "Their brief", 1),
      ],
    },
  ],
};

const SKILL: ResolvedGuidance = {
  declaration: { ref: "skill:creative-director" },
  rows: [
    {
      id: "s-1",
      title: "Creative director",
      version: null,
      order: null,
      fields: [],
      body: "Push for one clear idea.",
    },
  ],
};

describe("parseGuidanceRef / validators", () => {
  it("accepts kind and skill refs, never an id or another prefix", () => {
    expect(parseGuidanceRef("kind:brand-voice-guide")).toEqual({
      type: "kind",
      slug: "brand-voice-guide",
    });
    expect(parseGuidanceRef("skill:system/synap/creative-director")).toEqual({
      type: "skill",
      slug: "system/synap/creative-director",
    });
    expect(parseGuidanceRef("entity:2c0f1a3e")).toBeNull();
    expect(parseGuidanceRef("kind:Brand Voice")).toBeNull();
    expect(parseGuidanceRef("brand-voice-guide")).toBeNull();
    expect(parseGuidanceRef(42)).toBeNull();
  });

  it("refuses unknown keys, a where on a skill and an empty where list", () => {
    expect(validateGuidanceDeclaration({ ref: "kind:x", id: "1" })).toMatch(
      /only ref, label, when and where/
    );
    expect(
      validateGuidanceDeclaration({ ref: "skill:x", where: { a: ["b"] } })
    ).toMatch(/only a kind/);
    expect(
      validateGuidanceDeclaration({ ref: "kind:x", where: { a: [] } })
    ).toMatch(/where\.a/);
    expect(validateGuidanceDeclaration(VOICE.declaration)).toBeNull();
  });

  it("refuses a repeated item and a list over the cap, naming the index", () => {
    expect(
      validateGuidanceList([{ ref: "kind:a" }, { ref: "kind:a" }])
    ).toEqual([
      { index: 1, message: "guidance repeats kind:a with the same filter" },
    ]);
    // Same ref, another filter: two different items.
    expect(
      validateGuidanceList([
        { ref: "kind:a", where: { c: ["x"] } },
        { ref: "kind:a", where: { c: ["y"] } },
      ])
    ).toEqual([]);
    const many = Array.from({ length: MAX_GUIDANCE_ITEMS + 1 }, (_, i) => ({
      ref: `kind:k${i}`,
    }));
    expect(validateGuidanceList(many)[0]!.index).toBe(-1);
    expect(validateGuidanceList("kind:a")[0]!.index).toBe(-1);
  });
});

describe("renderGuidance", () => {
  it("renders nothing when nothing is declared", () => {
    expect(renderGuidance([])).toMatchObject({
      text: "",
      hash: null,
      used: [],
    });
  });

  it("renders items in DECLARED order, an ordered kind as numbered rows", () => {
    const out = renderGuidance([VOICE, ANGLES, SKILL]);
    expect(out.text).toBe(
      [
        GUIDANCE_HEADING,
        "### Voice · Outreach voice (v3)\n- Tone: warm, direct\n- Do: Cite the signal.\n  Keep it short.\n- Don't: Say synergy.",
        `### By kind of lead\n${GUIDANCE_ORDERED_SENTENCE}\n1. Posted on Malt (v4)\n   - When: posted an automation project\n   - Lead with: Their brief\n2. Default (v1)\n   - Lead with: A question`,
        "### Creative director\nPush for one clear idea.",
      ].join("\n\n")
    );
    expect(out.used.map((u) => u.ref)).toEqual([
      "kind:brand-voice-guide",
      "kind:outreach-angle",
      "skill:creative-director",
    ]);
    expect(out.used[1]!.rows).toEqual([
      { id: "a-1", version: "4" },
      { id: "a-2", version: "1" },
    ]);
    // Reversed declaration order → reversed sections: order is the author's.
    const reversed = renderGuidance([SKILL, ANGLES, VOICE]);
    expect(reversed.used.map((u) => u.ref)).toEqual([
      "skill:creative-director",
      "kind:outreach-angle",
      "kind:brand-voice-guide",
    ]);
  });

  it("gives the same bytes and hashes for any row or field order", () => {
    const shuffle = (r: ResolvedGuidance): ResolvedGuidance => ({
      declaration: Object.fromEntries(
        Object.entries(r.declaration).reverse()
      ) as ResolvedGuidance["declaration"],
      rows: [...r.rows]
        .reverse()
        .map((row): GuidanceRow => ({
          ...row,
          fields: [...row.fields].reverse(),
        })),
    });
    const a = renderGuidance([VOICE, ANGLES, SKILL]);
    const b = renderGuidance([shuffle(VOICE), shuffle(ANGLES), shuffle(SKILL)]);
    expect(b.text).toBe(a.text);
    expect(b.hash).toBe(a.hash);
    expect(b.used).toEqual(a.used);
    expect(a.hash).toMatch(/^[0-9a-f]{14}$/);
  });

  it("changes the item hash when a current version's content changes", () => {
    const edited: ResolvedGuidance = {
      ...VOICE,
      rows: [
        {
          ...VOICE.rows[0]!,
          fields: [field("voice-tone-descriptors", "Tone", "formal", 1)],
        },
      ],
    };
    const a = renderGuidance([VOICE]);
    const b = renderGuidance([edited]);
    expect(b.used[0]!.hash).not.toBe(a.used[0]!.hash);
    expect(b.hash).not.toBe(a.hash);
  });

  it("keeps whole items only within the budget, and names what it left out", () => {
    const big: ResolvedGuidance = {
      declaration: { ref: "skill:long-manual", label: "Manual" },
      rows: [
        {
          id: "s-big",
          title: "Manual",
          version: null,
          order: null,
          fields: [],
          body: "x".repeat(GUIDANCE_BUDGET_TOKENS * 4),
        },
      ],
    };
    const out = renderGuidance([VOICE, big, SKILL]);
    // The big item is out, whole; the later small one still fits.
    expect(out.used.map((u) => u.ref)).toEqual([
      "kind:brand-voice-guide",
      "skill:creative-director",
    ]);
    expect(out.text).not.toContain("xxxx");
    expect(out.text).toContain(
      "Left out to stay within the budget:\n- Manual (skill:long-manual): load it with synap_load_skill long-manual"
    );
    expect(out.demoted).toHaveLength(1);
    expect(out.tokens).toBeLessThanOrEqual(GUIDANCE_BUDGET_TOKENS);

    // A kind left out names the ids to load.
    const tight = renderGuidance([ANGLES], 20);
    expect(tight.used).toEqual([]);
    expect(tight.text).toContain(
      "- By kind of lead (kind:outreach-angle): load it with synap_get_entity a-1, a-2"
    );
  });

  it("names an item with no current version instead of dropping it", () => {
    const out = renderGuidance([
      VOICE,
      {
        declaration: { ref: "kind:positioning" },
        rows: [],
        missingReason: "no approved version yet",
      },
    ]);
    expect(out.missing).toEqual([
      {
        ref: "kind:positioning",
        label: "Positioning",
        reason: "no approved version yet",
      },
    ]);
    expect(
      out.text.endsWith(
        "Not available:\n- Positioning (kind:positioning): no approved version yet"
      )
    ).toBe(true);
  });
});
