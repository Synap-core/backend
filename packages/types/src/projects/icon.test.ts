import { describe, it, expect } from "vitest";
import {
  isProjectIcon,
  parseProjectIcon,
  projectGlyphIcon,
  PROJECT_ICON_MAX_LENGTH,
} from "./icon.js";

describe("parseProjectIcon", () => {
  it("reads one emoji, whatever its shape", () => {
    for (const emoji of [
      "🚀",
      "❤️", // presentation selector
      "👍🏽", // skin tone
      "👩‍👩‍👧‍👦", // ZWJ family
      "🏳️‍🌈", // ZWJ flag
      "🇫🇷", // regional-indicator flag
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿", // tag-sequence flag
      "1️⃣", // keycap
    ]) {
      expect(parseProjectIcon(emoji)).toEqual({ kind: "emoji", emoji });
    }
  });

  it("reads a glyph", () => {
    expect(parseProjectIcon("glyph:rocket")).toEqual({
      kind: "glyph",
      name: "rocket",
    });
    expect(parseProjectIcon(projectGlyphIcon("folder-open"))).toEqual({
      kind: "glyph",
      name: "folder-open",
    });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "A",
      "ab",
      "🚀🚀", // two emoji
      "🚀 ", // trailing text
      "🇫", // half a flag
      "1", // a digit is not a keycap
      "glyph:", // no name
      "glyph:Rocket", // not kebab
      "glyph:rocket ship",
      "glyph:-rocket",
      "glyph:../x",
      "rocket",
      `glyph:${"a".repeat(PROJECT_ICON_MAX_LENGTH)}`,
      null,
      undefined,
      42,
    ]) {
      expect(parseProjectIcon(bad)).toBeNull();
      expect(isProjectIcon(bad)).toBe(false);
    }
  });
});
