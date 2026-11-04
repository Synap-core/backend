import { describe, expect, it } from "vitest";
import { catalogProblems, createT } from "@synap-core/types/i18n";
import { en, fr } from "./copy";

describe("/open's catalogs", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });

  it("calls a living document a document, never a page", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = createT(locale, { en, fr });
      for (const key of ["document.live", "document.liveEditable"] as const) {
        expect(t(key).toLowerCase(), `${locale} ${key}`).not.toMatch(
          /\bpage\b/
        );
      }
    }
    expect(en["document.mark.live"]).toBe("Live");
  });
});
