import { describe, it, expect } from "vitest";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "./builtin-verbs.js";
import { SYNAP_CORE_DEFINITION } from "./ensure-synap-core.js";

/**
 * TRIPWIRE — the builtin verb catalog is coherent with the handler contract.
 *
 * A verb's param contract lives in TWO places: the Zod schema the handler parses
 * (builtin-verbs.ts) and the JSON-schema advertised in the seeded catalog
 * (ensure-synap-core.ts, consumed by list_capabilities). Historically these
 * drifted silently — a param added to the Zod schema but not the catalog is
 * accepted by the handler yet UNDISCOVERABLE (this bit channel.resolve.branchPurpose,
 * channel.create.metadata, feed.post.metadata, output.generate.options).
 *
 * This asserts: every param the handler accepts (Zod key) is advertised in the
 * catalog. If it fails, add the missing param to that verb's `parameters.properties`
 * in ensure-synap-core.ts (the reconciler self-heals the DB on next boot).
 */
describe("tripwire: builtin verb catalog advertises every handler param", () => {
  const catalog = new Map<string, Set<string>>();
  for (const skill of SYNAP_CORE_DEFINITION.skills) {
    const props =
      (skill.parameters as { properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
    catalog.set(skill.name, new Set(Object.keys(props)));
  }

  for (const [verb, schema] of Object.entries(BUILTIN_VERB_PARAM_SCHEMAS)) {
    it(`${verb}: every Zod param is advertised in the catalog`, () => {
      const advertised = catalog.get(verb);
      expect(
        advertised,
        `${verb} is in BUILTIN_VERB_PARAM_SCHEMAS but missing from SYNAP_CORE_DEFINITION`
      ).toBeTruthy();
      const zodKeys = Object.keys(schema.shape);
      const missing = zodKeys.filter((k) => !advertised!.has(k));
      expect(
        missing,
        `${verb} handler accepts param(s) the catalog does not advertise (undiscoverable): ${missing.join(", ")}`
      ).toEqual([]);
    });
  }
});
