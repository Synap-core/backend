import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — a failed `setProfileRenderer` must write NOTHING.
 *
 * THE BUG (review 2026-09-04): the function wrote the canonical
 * `renderer_bindings` row FIRST, then resolved the profile (pod scope) or the
 * workspace (workspace scope) for the legacy mirror and threw NOT_FOUND when
 * either was missing. There is no transaction across the two, so the caller saw
 * a failure while the pod kept a committed binding — and a retry with a
 * corrected slug orphaned the first row rather than replacing it.
 *
 * The invariant, stated positionally because that is what it is: every
 * existence check lives ABOVE the first write.
 */
const SRC = readFileSync(
  fileURLToPath(new URL("./set-profile-renderer.ts", import.meta.url)),
  "utf8"
);

/** Character offset of the first match, or -1. */
const at = (re: RegExp) => SRC.search(re);

describe("setProfileRenderer preflights before it writes", () => {
  const firstWrite = Math.min(
    ...[/setRendererBinding\(/, /revokeRendererBinding\(/]
      .map(at)
      .filter((i) => i > -1)
  );

  it("has a first write to locate", () => {
    expect(firstWrite).toBeGreaterThan(0);
    expect(Number.isFinite(firstWrite)).toBe(true);
  });

  it("resolves the profile and the workspace ABOVE the first write", () => {
    // The two lookups whose failure used to arrive too late.
    const profileLookup = at(/resolveProfile\(/);
    const workspaceLookup = at(/query\.workspaces\.findFirst\(/);
    expect(
      profileLookup,
      "resolveProfile must run before the write"
    ).toBeLessThan(firstWrite);
    expect(
      workspaceLookup,
      "the workspace lookup must run before the write"
    ).toBeLessThan(firstWrite);
  });

  it("throws every NOT_FOUND before the first write", () => {
    const notFounds = [...SRC.matchAll(/code:\s*"NOT_FOUND"/g)].map(
      (m) => m.index!
    );
    expect(
      notFounds.length,
      "both refusals still exist"
    ).toBeGreaterThanOrEqual(2);
    for (const i of notFounds) {
      expect(
        i,
        "a NOT_FOUND thrown after the binding write leaves a committed row " +
          "behind on a call that reported failure"
      ).toBeLessThan(firstWrite);
    }
  });

  it("the preflight is gated on the SAME condition as the mirror it guards", () => {
    // A user-scoped or per-object binding never mirrors, and its subjectKind is
    // routinely NOT a profile (`proposal`, `run`, … — the object-nav kind
    // string). Demanding a profile row for those would refuse exactly the
    // bindings the table exists for.
    expect(SRC).toMatch(
      /const willMirrorLegacy =\s*\n?\s*MIRROR_LEGACY_RENDERER_STORES && scope !== "user" && subjectId === null;/
    );
    expect(SRC).toMatch(/willMirrorLegacy && scope === "pod"/);
    expect(SRC).toMatch(/willMirrorLegacy && scope === "workspace"/);
  });
});
