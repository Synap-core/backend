/**
 * The def-less relation types the pod ACCEPTS (`SYSTEM_RELATION_TYPES` +
 * `IMPACT_RELATION_TYPES`, `utils/relation-types.ts`) must be exactly the
 * types `@synap-core/types/connections` BUILTIN_RELATION_TYPES gives words to.
 *
 * No catalog read can supply a label for a type with no `relation_defs` row, so
 * a new built-in that is missing here renders its forward word with a
 * reversed-arrow mark on every incoming edge — and a stale entry here labels a
 * type the pod no longer accepts. Both sides are DERIVED (imported), never
 * hand-listed in this test.
 */
import { describe, expect, it } from "vitest";
import { SYSTEM_RELATION_TYPES } from "@synap/database";
import { BUILTIN_RELATION_TYPES } from "@synap-core/types/connections";
import { IMPACT_RELATION_TYPES } from "../utils/relation-types.js";

describe("built-in relation labels cover exactly the def-less types", () => {
  it("BUILTIN_RELATION_TYPES keys === SYSTEM ∪ IMPACT relation types", () => {
    const accepted = [
      ...SYSTEM_RELATION_TYPES,
      ...IMPACT_RELATION_TYPES,
    ].sort();
    // non-vacuity: both sources are populated
    expect(accepted.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(BUILTIN_RELATION_TYPES).sort()).toEqual(accepted);
  });

  it("every DIRECTIONAL built-in carries an inverse label", () => {
    const missing = Object.values(BUILTIN_RELATION_TYPES)
      .filter((t) => t.isDirectional !== false && !t.inverseLabel)
      .map((t) => t.slug);
    expect(missing).toEqual([]);
  });
});
