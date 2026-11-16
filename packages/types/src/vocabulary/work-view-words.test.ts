/**
 * The Work view's words (plan 5207fbb6, 16 Nov 2026): Request and Branch, in
 * English and French, through the one door. "Request" is the `proposal` row
 * (founder G1), reached by its user word, never a second noun.
 */
import { describe, expect, it } from "vitest";

import { resolveObjectNoun, resolveObjectNounPlural } from "./index.js";

describe("Work view words", () => {
  it("names a branch (a child job drawn as a fork)", () => {
    expect(resolveObjectNoun("branch")).toBe("Branch");
    expect(resolveObjectNounPlural("branch")).toBe("Branches");
    expect(resolveObjectNoun("branch", "fr")).toBe("Branche");
    expect(resolveObjectNounPlural("branch", "fr")).toBe("Branches");
  });

  it("names a request by its user word, the same words as a proposal", () => {
    for (const locale of ["en", "fr"] as const) {
      expect(resolveObjectNoun("request", locale)).toBe(
        resolveObjectNoun("proposal", locale)
      );
      expect(resolveObjectNounPlural("requests", locale)).toBe(
        resolveObjectNounPlural("proposal", locale)
      );
    }
    expect(resolveObjectNoun("request")).toBe("Request");
    expect(resolveObjectNoun("request", "fr")).toBe("Demande");
  });

  it("keeps Job and Activity as they are", () => {
    expect(resolveObjectNoun("session")).toBe("Job");
    expect(resolveObjectNoun("activity")).toBe("Activity");
  });
});
