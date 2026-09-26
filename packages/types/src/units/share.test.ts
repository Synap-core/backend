import { describe, it, expect } from "vitest";
import { resolveShareState, SHARE_STATES, type ShareState } from "./share.js";
import type { UnitGlyph, UnitTone } from "./state.js";
import { resolveStatusLabel, humanizeToken } from "../vocabulary/index.js";

/**
 * Fixture rows are chosen where candidate orderings DISAGREE (guards-and-tests
 * §fixture coverage): every row below has a second, weaker signal present, so a
 * rule that checked the arms in another order would give a different answer.
 */
describe("resolveShareState — ORDER IS THE RULE", () => {
  const rows: Array<
    [string, Parameters<typeof resolveShareState>[0], ShareState]
  > = [
    [
      "revoked outranks a live publication",
      { revoked: true, published: true },
      "revoked",
    ],
    ["revoked outranks expired", { revoked: true, expired: true }, "revoked"],
    [
      "expired outranks a live link",
      { expired: true, liveLinks: 2 },
      "expired",
    ],
    [
      "public outranks link + guests",
      { published: true, liveLinks: 1, guestProjects: 3 },
      "public",
    ],
    ["link outranks guests", { liveLinks: 1, guestProjects: 3 }, "link"],
    [
      "guests alone",
      { guestProjects: 1, liveLinks: 0, published: false },
      "shared",
    ],
    [
      "a live answer beats a failed read",
      { guestProjects: 1, liveLinks: null },
      "shared",
    ],
    [
      "a failed read is NOT private",
      { published: false, liveLinks: null, guestProjects: 0 },
      "unmeasured",
    ],
    [
      "a failed publication read is NOT private",
      { published: null, liveLinks: 0, guestProjects: 0 },
      "unmeasured",
    ],
    [
      "nothing live, everything read",
      { published: false, liveLinks: 0, guestProjects: 0 },
      "private",
    ],
    ["nothing passed at all", {}, "private"],
  ];
  it.each(rows)("%s", (_label, input, expected) => {
    expect(resolveShareState(input).state).toBe(expected);
  });
});

describe("the mark: a tone token and a glyph, never a colour or a sentence", () => {
  const TONES: readonly UnitTone[] = [
    "primary",
    "ai",
    "info",
    "error",
    "success",
    "textSecondary",
    "textMuted",
  ];
  it("every state maps to a known tone, a glyph and a real status label", () => {
    const inputs: Record<ShareState, Parameters<typeof resolveShareState>[0]> =
      {
        private: {},
        shared: { guestProjects: 1 },
        link: { liveLinks: 1 },
        public: { published: true },
        expired: { expired: true },
        revoked: { revoked: true },
        unmeasured: { liveLinks: null },
      };
    for (const state of SHARE_STATES) {
      const view = resolveShareState(inputs[state]);
      expect(view.state).toBe(state);
      expect(TONES).toContain(view.tone);
      expect(view.tone).not.toMatch(/^#|rgb|var\(/);
      // Each state has a curated label (unmeasured → "Not checked"-style row is
      // not required: it humanizes), and the three reach words differ.
      expect(resolveStatusLabel(state)).toBeTruthy();
    }
    expect(resolveStatusLabel("link")).not.toBe(humanizeToken("link"));
  });

  it("uses the new glyphs, and never the AI tone (AI is provenance only)", () => {
    const glyphs: UnitGlyph[] = [
      resolveShareState({}).glyph,
      resolveShareState({ published: true }).glyph,
      resolveShareState({ guestProjects: 1 }).glyph,
    ];
    expect(glyphs).toEqual(["lock", "globe", "users"]);
    for (const state of SHARE_STATES) {
      expect(resolveShareState({ [state]: true } as never).tone).not.toBe("ai");
    }
  });

  it("public, link and guests share a tone and differ by glyph", () => {
    const pub = resolveShareState({ published: true });
    const link = resolveShareState({ liveLinks: 1 });
    const guests = resolveShareState({ guestProjects: 1 });
    expect(new Set([pub.tone, link.tone, guests.tone]).size).toBe(1);
    expect(new Set([pub.glyph, link.glyph, guests.glyph]).size).toBe(3);
    expect(resolveShareState({}).tone).not.toBe(pub.tone);
  });
});
