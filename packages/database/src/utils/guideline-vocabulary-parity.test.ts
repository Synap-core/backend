import { describe, it, expect } from "vitest";
import {
  GUIDELINE_SOURCE_KINDS,
  IMPORT_SOURCE_KIND_PREFIX,
  SCOPE_SPECIFICITY,
} from "./config-settings.js";
import { CONFIG_SCOPE_KINDS } from "../schema/config-settings.js";
// TEST-ONLY relative import of the AUTHORED lists. `@synap/database` cannot
// depend on `@synap-core/types` (types already depends on database — a build
// cycle), so no package dependency is declared; tsconfig excludes tests, so this
// path never enters the database build.
import * as authored from "../../../types/src/guidelines/index.js";

/**
 * PARITY: the guideline vocabularies the pod RESOLVES with are the ones the
 * browser and relay EDIT with.
 *
 * The authored lists live in `@synap-core/types/guidelines`. This package keeps
 * a runtime mirror because it cannot import them. These assertions compare the
 * VALUES the two modules export at runtime — behavioural, not a regex over
 * source — including the scope ORDER as the resolver actually ranks it
 * (`SCOPE_SPECIFICITY`, derived from the private `SCOPE_ORDER`).
 *
 * WHAT THIS PROVES: SAMENESS, never CORRECTNESS. If both sides agree on a wrong
 * order or a wrong kind, this stays green — a convergence guard cannot tell a
 * shared mistake from a shared truth.
 *
 * WHAT IT DOES NOT COVER: the `import:<source>` tail vocabulary
 * (`IMPORT_SOURCE_VALUES`) — already single-sourced in `@synap-core/types` and
 * imported by the api gate; and anything a UI hand-copies instead of importing.
 */
describe("guideline vocabulary parity — database mirror === @synap-core/types author", () => {
  it("non-vacuity: both sides export real, non-trivial lists", () => {
    expect(authored.GUIDELINE_SOURCE_KINDS.length).toBeGreaterThanOrEqual(5);
    expect(authored.GUIDELINE_SCOPE_ORDER.length).toBeGreaterThanOrEqual(8);
    expect(authored.GUIDELINE_SCOPE_ORDER).toContain("entityKind");
    expect(GUIDELINE_SOURCE_KINDS).toContain("image");
    expect(Object.keys(SCOPE_SPECIFICITY).length).toBeGreaterThanOrEqual(8);
  });

  it("GUIDELINE_SOURCE_KINDS are identical, in order", () => {
    expect([...GUIDELINE_SOURCE_KINDS]).toEqual([
      ...authored.GUIDELINE_SOURCE_KINDS,
    ]);
    expect(IMPORT_SOURCE_KIND_PREFIX).toBe(authored.IMPORT_SOURCE_KIND_PREFIX);
  });

  it("the scope ORDER the resolver ranks by is the authored order", () => {
    const resolverOrder = Object.entries(SCOPE_SPECIFICITY)
      .sort((a, b) => a[1] - b[1])
      .map(([kind]) => kind);
    expect(resolverOrder).toEqual([...authored.GUIDELINE_SCOPE_ORDER]);
  });

  it("the stored enum holds exactly the authored scope kinds (set equality)", () => {
    expect([...CONFIG_SCOPE_KINDS].sort()).toEqual(
      [...authored.GUIDELINE_SCOPE_ORDER].sort()
    );
  });
});
