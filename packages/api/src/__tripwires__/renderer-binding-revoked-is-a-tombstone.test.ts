import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * TRIPWIRE — a REVOKED renderer binding is a tombstone every reader walks past.
 *
 * `revokeRendererBinding` does not delete: it stamps `revoked_at` and leaves the
 * row as history, so resolution continues to the next rung exactly as if the
 * binding had never existed. That contract is only kept if EVERY reader
 * excludes the tombstone — a reader that forgets serves a renderer the user
 * explicitly unbound, and there is nothing in the type system to catch it
 * (`revoked_at` is just a nullable column; omitting a predicate typechecks).
 *
 * The access-layer `VisibilityRule` for `rendererBindings` omitted it while the
 * resolver had it, so a `scopedDb` read and `resolveRendererBinding` disagreed
 * about what was live. Both now go through the one exported predicate.
 *
 * A source scan, not a behavioural test: the defect is an ABSENT clause, and an
 * absent clause has no runtime symptom until a user unbinds something.
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const READERS = {
  "access/registry.ts": "../access/registry.ts",
  "database ProfileResolutionService":
    "../../../database/src/services/profile-resolution-service.ts",
  "database renderer-binding-service":
    "../../../database/src/services/renderer-binding-service.ts",
} as const;

describe("a revoked renderer binding is invisible to every reader", () => {
  it("exports ONE live-binding predicate", () => {
    const src = read(READERS["database renderer-binding-service"]);
    expect(
      /export function activeRendererBindingWhere\(\)/.test(src),
      "the shared predicate is gone — each reader is back to spelling the " +
        "tombstone check out, which is how the access rule lost it"
    ).toBe(true);
    expect(src).toMatch(/isNull\(rendererBindings\.revokedAt\)/);
  });

  for (const [name, rel] of Object.entries(READERS)) {
    it(`${name} reads through the shared predicate`, () => {
      expect(
        /activeRendererBindingWhere\(\)/.test(read(rel)),
        `${name} no longer applies the live-binding predicate — it will serve ` +
          `bindings the user explicitly unbound`
      ).toBe(true);
    });
  }

  it("no reader hand-rolls the tombstone check instead", () => {
    // The predicate's own definition is the ONE allowed occurrence.
    for (const [name, rel] of Object.entries(READERS)) {
      const hits = read(rel).match(/isNull\(rendererBindings\.revokedAt\)/g);
      const allowed = name === "database renderer-binding-service" ? 1 : 0;
      expect(
        hits?.length ?? 0,
        `${name} spells the tombstone check out instead of calling the shared ` +
          `predicate — a second copy is a second thing to forget to tighten`
      ).toBe(allowed);
    }
  });
});
