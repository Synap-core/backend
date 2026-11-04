/**
 * THE PROPERTY KEY: every slug the define door makes is a key every naming
 * door accepts (CP ticket 5980e79d). Rules out: the slugifier and the key
 * grammar drifting apart again (`contracts_total` → `contracts-total`, then
 * refused by a `[A-Za-z0-9_]` grammar).
 */

import { describe, it, expect } from "vitest";
import {
  PROPERTY_KEY_MAX_LENGTH,
  PROPERTY_KEY_PATTERN,
  slugifyPropertyKey,
} from "./property-key.js";
import { slugifyPropertyKey as reExported } from "../services/property-reconciliation.js";
import { MACHINE_WRITTEN_PROPERTY_SLUGS } from "./machine-written-properties.js";

describe("property key: what the define door makes is a key", () => {
  it.each([
    ["contracts_total", "contracts-total"],
    ["Funding Amount", "funding-amount"],
    ["uo_category", "uo-category"],
    ["2024 revenue", "2024-revenue"],
    ["  Score!! ", "score"],
    ["ek_type", "ek-type"],
  ])("%j → %j is a key", (label, slug) => {
    expect(slugifyPropertyKey(label)).toBe(slug);
    expect(PROPERTY_KEY_PATTERN.test(slug)).toBe(true);
  });

  it("any label: a non-empty slug within the def door's length is a key", () => {
    // Deterministic pseudo-random labels: words, separators, punctuation,
    // digits, unicode — whatever the slugifier keeps must be a key.
    const alphabet = "aZ09_- .!/éß—\t-_xY";
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    let checked = 0;
    for (let i = 0; i < 2000; i += 1) {
      const len = 1 + (next() % 40);
      let label = "";
      for (let j = 0; j < len; j += 1)
        label += alphabet[next() % alphabet.length];
      const slug = slugifyPropertyKey(label);
      if (slug === "" || slug.length > PROPERTY_KEY_MAX_LENGTH) continue;
      checked += 1;
      expect(PROPERTY_KEY_PATTERN.test(slug), `${label} → ${slug}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("the keys built-in kinds store (camelCase, snake_case) stay keys", () => {
    for (const key of [
      ...MACHINE_WRITTEN_PROPERTY_SLUGS,
      "linkedinUrl",
      "last_seen",
      "title",
    ]) {
      expect(PROPERTY_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it.each(["", "-leading", "has space", "a.b", "a->b", "x".repeat(101)])(
    "%j is not a key",
    (key) => {
      expect(PROPERTY_KEY_PATTERN.test(key)).toBe(false);
    }
  );

  it("`@synap/database` re-exports the SAME slugifier", () => {
    expect(reExported).toBe(slugifyPropertyKey);
  });
});
