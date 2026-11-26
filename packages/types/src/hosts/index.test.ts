import { describe, expect, it } from "vitest";
import {
  DEPRECATED_IN_HOSTS,
  deprecatedInHost,
  isDeprecatedInHost,
} from "./index.js";

describe("DEPRECATED_IN_HOSTS", () => {
  it("is non-vacuous and every entry is fully shaped", () => {
    // 8 since relay `pipeline` was deleted (2026-10-14).
    expect(DEPRECATED_IN_HOSTS.length).toBeGreaterThanOrEqual(8);
    for (const s of DEPRECATED_IN_HOSTS) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(["browser", "relay"]).toContain(s.host);
      expect(s.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.replacedBy.length).toBeGreaterThan(0);
      expect(s.decisionDoc.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (host, id) pair", () => {
    const seen = new Set<string>();
    for (const s of DEPRECATED_IN_HOSTS) {
      const key = `${s.host}:${s.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("contains the specific browser ids the V1 plan marks DEPRECATE, plus 2A's import and files", () => {
    const browserIds = deprecatedInHost("browser").map((s) => s.id);
    expect(browserIds.sort()).toEqual(
      // `import` / `files`: founder 2A (2026-10-19) — the capture Library is
      // Library › Kept, the Files app is Library › Documents.
      ["activity", "files", "governance", "import", "work-map"].sort()
    );
  });

  it("contains the specific relay ids the V1 plan marks DEPRECATE", () => {
    const relayIds = deprecatedInHost("relay").map((s) => s.id);
    expect(relayIds.sort()).toEqual(
      // `work`: the Goals tab, a redirect to `/goals` (16 Nov 2026).
      ["feed", "gallery", "idea-studio", "rules", "work"].sort()
    );
  });

  it("isDeprecatedInHost is true only for registered (host, id) pairs", () => {
    expect(isDeprecatedInHost("browser", "governance")).toBe(true);
    expect(isDeprecatedInHost("relay", "rules")).toBe(true);
    // negative control: a real, non-deprecated id must read false
    expect(isDeprecatedInHost("browser", "sessions")).toBe(false);
    expect(isDeprecatedInHost("relay", "home")).toBe(false);
    // The relay Goals tab (id `work`) is retired; the browser's Work is not.
    expect(isDeprecatedInHost("relay", "work")).toBe(true);
    expect(isDeprecatedInHost("browser", "work")).toBe(false);
    // wrong surface for a real id must also read false (no cross-surface leak)
    expect(isDeprecatedInHost("relay", "governance")).toBe(false);
  });
});
