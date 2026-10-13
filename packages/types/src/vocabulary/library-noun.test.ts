import { describe, expect, it } from "vitest";
import {
  OBJECT_NOUNS,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "./index.js";
import { OBJECT_KINDS } from "./object-kinds.js";

/**
 * "Library" — everything a person brings in (docs/CAPTURE_LIBRARY_PLAN.md §1).
 *
 * Checked first (wave L1): the noun needs NO row. It is not a registry kind
 * yet (wave L2 decides its model), and `humanizeToken` already says "Library"
 * / "Libraries". A row in `OBJECT_NOUNS` would be WORSE than none: that
 * table's plural is the singular + "s", so it would read "Librarys". These
 * pins keep it that way until the Library becomes a registry kind with a
 * curated `labelPlural`.
 */
describe("the Library noun", () => {
  it("resolves through the one door, singular and plural", () => {
    expect(resolveObjectNoun("library")).toBe("Library");
    expect(resolveObjectNounPlural("library")).toBe("Libraries");
    expect(resolveObjectNoun("library_item")).toBe("Library item");
    expect(resolveObjectNounPlural("library_item")).toBe("Library items");
  });

  it("has no backend-only row that would break the plural", () => {
    expect(OBJECT_NOUNS.library).toBeUndefined();
    // When it becomes a registry kind, its plural must be curated.
    const kind = OBJECT_KINDS.library;
    if (kind) expect(kind.labelPlural).toBe("Libraries");
  });
});
