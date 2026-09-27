import { describe, expect, it } from "vitest";
import {
  DEPRECATED_SURFACES,
  deprecatedSurfacesFor,
  isDeprecatedSurface,
} from "./index.js";

describe("DEPRECATED_SURFACES", () => {
  it("is non-vacuous and every entry is fully shaped", () => {
    expect(DEPRECATED_SURFACES.length).toBeGreaterThanOrEqual(9);
    for (const s of DEPRECATED_SURFACES) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(["browser", "relay"]).toContain(s.surface);
      expect(s.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.replacedBy.length).toBeGreaterThan(0);
      expect(s.decisionDoc.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (surface, id) pair", () => {
    const seen = new Set<string>();
    for (const s of DEPRECATED_SURFACES) {
      const key = `${s.surface}:${s.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("contains the specific browser ids the V1 plan marks DEPRECATE", () => {
    const browserIds = deprecatedSurfacesFor("browser").map((s) => s.id);
    expect(browserIds.sort()).toEqual(
      ["activity", "governance", "processors", "work-map"].sort()
    );
  });

  it("contains the specific relay ids the V1 plan marks DEPRECATE", () => {
    const relayIds = deprecatedSurfacesFor("relay").map((s) => s.id);
    expect(relayIds.sort()).toEqual(
      ["feed", "gallery", "idea-studio", "pipeline", "rules"].sort()
    );
  });

  it("isDeprecatedSurface is true only for registered (surface, id) pairs", () => {
    expect(isDeprecatedSurface("browser", "governance")).toBe(true);
    expect(isDeprecatedSurface("relay", "rules")).toBe(true);
    // negative control: a real, non-deprecated id must read false
    expect(isDeprecatedSurface("browser", "sessions")).toBe(false);
    expect(isDeprecatedSurface("relay", "home")).toBe(false);
    // wrong surface for a real id must also read false (no cross-surface leak)
    expect(isDeprecatedSurface("relay", "governance")).toBe(false);
  });
});
