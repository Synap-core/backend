/**
 * GUARD — `@synap-core/types/property-render` stays a LEAF.
 *
 * Relay (Hermes) and pod-admin's server components read these rules; the
 * app-bases copies they replace were each guarded by a DOM-free import-graph
 * test (`classify/dom-free.test.ts`, `semantics.leaf.test.ts`). The guard moves
 * with the code: every import here is a sibling file or one of the two pure
 * `@synap-core/types` modules the rules need. No zod, drizzle, React, DOM.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED_OUTSIDE = new Set([
  "../vocabulary/index.js",
  "../units/state.js",
]);

describe("property-render leaf subpath", () => {
  it("imports only sibling files and the allow-listed pure modules", () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
    );
    // Non-vacuity: the scan reached the rule modules, not an empty folder.
    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "classify-property.ts",
        "entity-field-plan.ts",
        "structured-value.ts",
        "enum-tone.ts",
      ])
    );
    const outside = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(
        /^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm
      )) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        outside.add(spec);
        expect(ALLOWED_OUTSIDE.has(spec), `${f} imports ${spec}`).toBe(true);
      }
    }
    // An allow entry nothing uses would silently widen the guard.
    expect([...outside].sort()).toEqual([...ALLOWED_OUTSIDE].sort());
  });
});
