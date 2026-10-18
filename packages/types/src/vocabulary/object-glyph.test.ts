import { describe, expect, it } from "vitest";
import {
  FALLBACK_GLYPH,
  identitySlotForKind,
  identityToken,
  resolveObjectGlyph,
  resolveObjectIdentity,
  resolveObjectNoun,
} from "./index.js";

/**
 * The glyph door — what a surface with no icon font (the synap-bridge terminal
 * band) draws for a kind. It used to keep its own `KIND_GLYPH` table, which
 * disagreed with this registry on `note` (✎ there, ▤ here). The registry wins.
 */
describe("resolveObjectGlyph", () => {
  it("reads the registry glyph for the kinds a session produces", () => {
    expect(resolveObjectGlyph("task")).toBe("☐");
    expect(resolveObjectGlyph("note")).toBe("▤");
    expect(resolveObjectGlyph("document")).toBe("▤");
    expect(resolveObjectGlyph("decision")).toBe("◇");
    expect(resolveObjectGlyph("report")).toBe("▤");
    expect(resolveObjectGlyph("code")).toBe("⟨⟩");
  });

  it("resolves an alias before reading, like the noun does", () => {
    // `documents` is a table-name alias of `document`.
    expect(resolveObjectGlyph("documents")).toBe(
      resolveObjectGlyph("document")
    );
    expect(resolveObjectGlyph("Task")).toBe("☐");
  });

  it("never returns an empty mark: unknown and missing kinds read the fallback", () => {
    expect(resolveObjectGlyph("meeting_minutes")).toBe(FALLBACK_GLYPH);
    expect(resolveObjectGlyph(null)).toBe(FALLBACK_GLYPH);
    expect(resolveObjectGlyph("")).toBe(FALLBACK_GLYPH);
  });

  it("registering decision/report kept the hue the fallback already gave them", () => {
    for (const kind of ["decision", "report"]) {
      expect(resolveObjectIdentity(kind).color).toBe(
        identityToken(identitySlotForKind(kind))
      );
    }
    expect(resolveObjectNoun("decision")).toBe("Decision");
    expect(resolveObjectNoun("report")).toBe("Report");
  });
});
