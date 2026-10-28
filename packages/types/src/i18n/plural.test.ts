/**
 * CLDR test vectors: the `@integer` / `@decimal` samples of CLDR 46
 * `supplemental/plurals.xml` for en and fr, the ones a JS number can express
 * (a sample such as "1.0" or "1c6" has no JS-number twin and is skipped).
 */
import { describe, expect, it } from "vitest";
import { PLURAL_CATEGORIES, pluralCategory } from "./plural.js";
import type { Locale } from "./locale.js";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const VECTORS: Record<Locale, Record<string, number[]>> = {
  en: {
    one: [1],
    other: [
      0,
      ...range(2, 16),
      100,
      1000,
      10000,
      100000,
      1000000,
      0.1,
      0.5,
      1.5,
      1.1,
      10.5,
    ],
  },
  fr: {
    one: [0, 1, 0.5, 1.5, 1.1, 0.01],
    many: [1000000, 2000000, 3000000, 4000000, 5000000, 6000000, 10000000],
    other: [
      ...range(2, 17),
      100,
      1000,
      10000,
      100000,
      2000,
      2.5,
      3.5,
      10.5,
      1000001,
      1500000,
      1000000.5,
    ],
  },
};

describe("pluralCategory", () => {
  for (const [locale, byCategory] of Object.entries(VECTORS) as [
    Locale,
    Record<string, number[]>,
  ][]) {
    for (const [category, samples] of Object.entries(byCategory)) {
      it(`${locale}: ${category} for ${samples.join(", ")}`, () => {
        for (const n of samples) {
          expect(pluralCategory(locale, n), `${locale} ${n}`).toBe(category);
        }
      });
    }
  }

  it("reads the absolute value", () => {
    expect(pluralCategory("en", -1)).toBe("one");
    expect(pluralCategory("fr", -1.5)).toBe("one");
    expect(pluralCategory("fr", -2000000)).toBe("many");
  });

  it("counts fraction digits written with an exponent", () => {
    expect(pluralCategory("en", 1e-7)).toBe("other");
    expect(pluralCategory("fr", 1e-7)).toBe("one");
  });

  it("is other for a value that is not a finite number", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(pluralCategory("en", n)).toBe("other");
      expect(pluralCategory("fr", n)).toBe("other");
    }
  });

  it("only returns the categories each locale declares", () => {
    const samples = [...range(0, 30), 0.5, 1.5, 1e6, 2e6, 1e9, 1234567];
    for (const locale of ["en", "fr"] as const) {
      for (const n of samples) {
        expect(PLURAL_CATEGORIES[locale]).toContain(pluralCategory(locale, n));
      }
    }
  });
});
