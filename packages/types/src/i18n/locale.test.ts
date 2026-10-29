import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
  resolveLocale,
} from "./locale.js";

describe("SUPPORTED_LOCALES", () => {
  it("is English first (the source) then French", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "fr"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });
});

describe("isLocale", () => {
  it("accepts exactly a supported locale", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(true);
    for (const v of ["FR", "fr-FR", "de", "", null, undefined, 1]) {
      expect(isLocale(v)).toBe(false);
    }
  });
});

describe("resolveLocale", () => {
  it("takes the first supported language, in order", () => {
    expect(resolveLocale(["fr", "en"])).toBe("fr");
    expect(resolveLocale(["en", "fr"])).toBe("en");
    expect(resolveLocale(["de-DE", "fr-CA", "en"])).toBe("fr");
  });

  it("matches the primary subtag, any case, - or _", () => {
    for (const tag of ["fr-FR", "FR", "fr_BE", " fr-ca ", "fr-Latn-FR"]) {
      expect(resolveLocale([tag])).toBe("fr");
    }
  });

  it("falls back to English when nothing is supported", () => {
    expect(resolveLocale([])).toBe("en");
    expect(resolveLocale(["de", "ja-JP", "", "*"])).toBe("en");
    expect(resolveLocale(["frr"])).toBe("en"); // North Frisian, not French
  });
});
