/**
 * `byOp` fallback keys are the CANONICAL positional ref — `opRef(n)`, the Nth
 * create_entity op (what dispositions and the scanner address) — never the
 * op's index among ALL ops.
 *
 * Seam: `buildMaterializedRecord` from a materializer-shaped result. Not driven
 * through the real materializer (it needs a rule door); the result shape here
 * is `MaterializeResult`'s own fields. LIMIT: a create_entity op the
 * materializer skips has no result, so the ordinal cannot see it (documented in
 * `buildByOp`).
 */

import { describe, it, expect } from "vitest";
import { opRef } from "@synap-core/types/proposals";
import { buildMaterializedRecord } from "./stamp-materialized.js";
import type { MaterializeResult } from "../../utils/materialize-composite.js";

describe("buildMaterializedRecord byOp keys", () => {
  it("a ref-less entity after a rule op is keyed by its create_entity ordinal, and its facets follow it", () => {
    const record = buildMaterializedRecord({
      // Deliberately out of op order: the key must not depend on array order.
      entities: [
        { opIndex: 4, entityId: "entity-3", linked: false },
        { opIndex: 1, entityId: "entity-1", linked: false },
        { opIndex: 3, ref: "b", entityId: "entity-2", linked: false },
      ] as unknown as MaterializeResult["entities"],
      relations: [],
      // op 0 is a rule — it must not shift the entity ordinals.
      rules: [
        { ref: "r1", opIndex: 0, ruleId: "rule-1" },
      ] as unknown as MaterializeResult["rules"],
      facets: [
        { opIndex: 4, facetId: "facet-1" },
      ] as unknown as MaterializeResult["facets"],
    });

    expect(Object.keys(record.byOp ?? {}).sort()).toEqual(
      [opRef(0), "b", opRef(2), "r1"].sort()
    );
    expect(record.byOp?.[opRef(0)]).toMatchObject({ entityId: "entity-1" });
    expect(record.byOp?.[opRef(2)]).toMatchObject({
      entityId: "entity-3",
      facetIds: ["facet-1"],
    });
    expect(record.byOp?.r1).toMatchObject({
      op: "create_rule",
      ruleId: "rule-1",
    });
  });
});
