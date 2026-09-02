/**
 * synap-core is covered by NEITHER verb-catalog guard — and that is only
 * honest while its verb-catalog projection is EMPTY.
 *
 * The general reconcile (`reconcile-capabilities-to-templates.ts`) runs both
 * `capabilityDefinitionDrift` (skills rows) AND `capabilityVerbCatalogDrift`
 * (the `tools.capabilities` jsonb). synap-core is seeded from an IN-REPO
 * constant with no Control-Plane template, so `loadCapabilityTemplate` throws
 * for it and that reconcile SKIPS it entirely; `ensureSynapCoreCapability`
 * runs only `capabilityDefinitionDrift`, and stamps no contentHash or
 * comparator version at all.
 *
 * WHY THAT IS SAFE TODAY, AND EXACTLY WHEN IT STOPS BEING SAFE:
 * `deriveToolVerbs` — the ONE applier-side projection — emits a verb only for a
 * skill whose `requires` names a tool. `SYNAP_CORE_DEFINITION` declares
 * `tools: []` and no skill `requires` anything, so the projection is EMPTY:
 * there is no `tools.capabilities` row for synap-core to drift, and the missing
 * guard has nothing to catch. Wiring `capabilityVerbCatalogDrift` in today
 * would be a VACUOUS check — green over an empty map, proving nothing.
 *
 * The moment synap-core declares a tool (or a skill `requires` one), the
 * projection becomes non-empty and cross-table-projected fields — `intent`
 * above all, which lives ONLY on `tools.capabilities` and never on a `skills`
 * row — start landing on a surface NO guard here compares. That is the exact
 * defect this session root-caused: a field that silently never reaches the pod.
 *
 * So this pins the PRECONDITION, derived from the applier's own projection
 * rather than hand-maintained: if the projection stops being empty, wire
 * `capabilityVerbCatalogDrift` into `ensureSynapCoreCapability` before shipping.
 */
import { describe, it, expect } from "vitest";

import { SYNAP_CORE_DEFINITION } from "./ensure-synap-core.js";
import {
  deriveToolVerbs,
  GRANT_DEFAULT_EXEC_MODE,
} from "./create-from-definition.js";

const WHY =
  "synap-core's verb-catalog projection is no longer empty, so its verbs now " +
  "land on `tools.capabilities` — a surface `ensureSynapCoreCapability` does " +
  "NOT compare (it runs capabilityDefinitionDrift only, over `skills` rows). " +
  "Cross-table-projected fields (`intent`) would silently never reach the pod, " +
  "and the boot would report convergence anyway. FIX: run " +
  "`capabilityVerbCatalogDrift(memberToolRows, projectedVerbs)` in " +
  "`ensureSynapCoreCapability` alongside `capabilityDefinitionDrift`, the way " +
  "`reconcile-capabilities-to-templates.ts` does — do not just update this test.";

describe("ensureSynapCoreCapability — verb-catalog coverage precondition", () => {
  /**
   * Every tool name the projection could key on: the ones declared, plus the
   * ones a skill `requires` (a `requires` naming an undeclared tool still makes
   * `deriveToolVerbs` emit, so both sources must be swept).
   */
  const candidateToolNames = new Set<string>([
    ...(SYNAP_CORE_DEFINITION.tools ?? []).map((t) => t.name),
    ...SYNAP_CORE_DEFINITION.skills.flatMap((s) => s.requires ?? []),
  ]);

  it("projects no verbs onto any tool", () => {
    const projected = [...candidateToolNames].flatMap((name) =>
      deriveToolVerbs(
        name,
        SYNAP_CORE_DEFINITION.skills,
        GRANT_DEFAULT_EXEC_MODE
      )
    );
    expect(projected, WHY).toEqual([]);
  });

  it("declares no skill that requires a tool", () => {
    const requiring = SYNAP_CORE_DEFINITION.skills
      .filter((s) => (s.requires ?? []).length > 0)
      .map((s) => s.name);
    expect(requiring, WHY).toEqual([]);
  });
});
