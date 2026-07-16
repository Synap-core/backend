/**
 * Unit tests for normalizeProfileScope — the shared scope-token door.
 *
 * The regression under test: templates declare scope in MIXED case, and the two
 * provisioning doors each had a private UPPERCASE-keyed `Record<string, string>`
 * lookup. `scopeMap["shared"]` returned `undefined`, the `?? "workspace"`
 * fallback ate it, and all 17 lowercase-declared pod-wide `shared` roles were
 * silently demoted to private per-workspace duplicates — while `tsc` stayed
 * green, because `Record<string, string>` accepts any key.
 */

import { describe, expect, it } from "vitest";
import { normalizeProfileScope } from "./normalize-profile-scope.js";
import { ProfileScope } from "../schema/profiles.js";

describe("normalizeProfileScope", () => {
  it("maps lowercase 'shared' to SHARED (THE regression — was silently 'workspace')", () => {
    // `@synap-core/workspace-templates` ships 17 profiles declaring `scope: "shared"`
    // in lowercase. Under the old UPPERCASE-keyed map every one of them resolved
    // to `undefined` → "workspace", forking a private duplicate of a profile that
    // is meant to be ONE pod-wide row, and making the apply layer's pod-wide
    // branches dead code.
    expect(normalizeProfileScope("shared")).toBe(ProfileScope.SHARED);
    expect(normalizeProfileScope("shared")).not.toBe(ProfileScope.WORKSPACE);
  });

  it("maps UPPERCASE 'WORKSPACE' to WORKSPACE (the 55 that always worked)", () => {
    expect(normalizeProfileScope("WORKSPACE")).toBe(ProfileScope.WORKSPACE);
  });

  it("accepts BOTH vocabularies for every scope — casing is never load-bearing", () => {
    for (const [upper, expected] of [
      ["SYSTEM", ProfileScope.SYSTEM],
      ["SHARED", ProfileScope.SHARED],
      ["WORKSPACE", ProfileScope.WORKSPACE],
      ["USER", ProfileScope.USER],
    ] as const) {
      expect(normalizeProfileScope(upper)).toBe(expected);
      expect(normalizeProfileScope(upper.toLowerCase())).toBe(expected);
      // Mixed case resolves identically — no vocabulary is privileged.
      expect(
        normalizeProfileScope(upper[0] + upper.slice(1).toLowerCase())
      ).toBe(expected);
    }
  });

  it("tolerates surrounding whitespace from hand-edited YAML", () => {
    expect(normalizeProfileScope("  shared  ")).toBe(ProfileScope.SHARED);
  });

  it("falls back to WORKSPACE (the PRIVATE default) for absent/unknown tokens", () => {
    // The fallback direction is a safety property, not an accident: a wrong
    // `workspace` forks one extra row, whereas a wrong pod-wide scope would hand
    // a template write access to a shared identity.
    expect(normalizeProfileScope(undefined)).toBe(ProfileScope.WORKSPACE);
    expect(normalizeProfileScope(null)).toBe(ProfileScope.WORKSPACE);
    expect(normalizeProfileScope("")).toBe(ProfileScope.WORKSPACE);
    expect(normalizeProfileScope("nonsense")).toBe(ProfileScope.WORKSPACE);
  });

  it("returns values that are exactly the DB enum (safe to persist directly)", () => {
    const dbVocabulary = Object.values(ProfileScope);
    for (const token of ["system", "SHARED", "workspace", "User", "bogus"]) {
      expect(dbVocabulary).toContain(normalizeProfileScope(token));
    }
  });
});
