/**
 * The review detail's grant-request words are one catalog (en + fr), and the
 * proposal page's door to the updated object is a message of its own: both
 * hold every key, with the same arguments, in French.
 */
import { describe, expect, it } from "vitest";
import { catalogProblems } from "@synap-core/types/i18n";
import { DRAWER_CATALOGS, NAME_MARK } from "./drawer-copy";
import { en as pageEn, fr as pageFr } from "../../../proposal/[id]/copy";

describe("drawer copy", () => {
  it("the French catalog has every key, the same arguments, no extra", () => {
    expect(catalogProblems(DRAWER_CATALOGS)).toEqual([]);
    expect(catalogProblems({ en: pageEn, fr: pageFr })).toEqual([]);
  });

  it("every sentence that names someone keeps exactly one mark for the name", () => {
    const marked = Object.entries(DRAWER_CATALOGS.en).filter(([, m]) =>
      m.includes("{mark}")
    );
    expect(marked.length).toBeGreaterThan(5);
    for (const [key, message] of marked) {
      for (const catalog of [DRAWER_CATALOGS.en, DRAWER_CATALOGS.fr]) {
        const text = catalog[key as keyof typeof catalog];
        expect(text.split("{mark}").length - 1, `${key}`).toBe(1);
      }
      expect(message).not.toContain(NAME_MARK);
    }
  });
});
