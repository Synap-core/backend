/**
 * DURABLE_OBJECT_VERBS is DERIVED from the verb registry, never hand-kept.
 *
 * `proposal-class.ts` imports nothing (so every read door can import it
 * without a cycle), which forces its verb set to be a literal. This is the
 * price: the set is recomputed here from the registry the handlers actually
 * run — `BUILTIN_VERBS`, `READ_ONLY_BUILTIN_VERBS`, `BUILTIN_VERB_PARAM_SCHEMAS`
 * — and any difference fails.
 *
 * THE RULE: a builtin WRITE verb whose declared params name the existing
 * object it acts on (`DURABLE_OBJECT_ID_PARAMS`), plus the `<ns>.create` write
 * verb of any such namespace. A new `document.archive({ documentId })` joins
 * the expected set by existing; if it is not added to the literal, a pending
 * request to archive a document would expire in 24h — so this goes red.
 *
 * NOT covered, measured by reading: agent-authored / connector verbs (not in
 * the builtin registry) stay `ephemeral` by construction; a verb whose params
 * are parsed inline with no entry in `BUILTIN_VERB_PARAM_SCHEMAS` (`feed.read`)
 * is invisible to the id-param rule.
 */

import { describe, it, expect } from "vitest";
import {
  BUILTIN_VERBS,
  BUILTIN_VERB_PARAM_SCHEMAS,
  READ_ONLY_BUILTIN_VERBS,
} from "../services/capabilities/builtin-verbs.js";
import {
  DURABLE_OBJECT_ID_PARAMS,
  DURABLE_OBJECT_VERBS,
} from "../services/proposals/proposal-class.js";

function derive(): { expected: Set<string>; writeVerbs: string[] } {
  const writeVerbs = Object.keys(BUILTIN_VERBS).filter(
    (v) => !READ_ONLY_BUILTIN_VERBS.has(v)
  );
  const idKeys = new Set(DURABLE_OBJECT_ID_PARAMS);
  const idVerbs = writeVerbs.filter((v) =>
    Object.keys(BUILTIN_VERB_PARAM_SCHEMAS[v]?.shape ?? {}).some((k) =>
      idKeys.has(k)
    )
  );
  const namespaces = new Set(idVerbs.map((v) => v.split(".")[0]));
  const creates = writeVerbs.filter((v) => {
    const [ns, action] = v.split(".");
    return action === "create" && namespaces.has(ns!);
  });
  return { expected: new Set([...idVerbs, ...creates]), writeVerbs };
}

describe("DURABLE_OBJECT_VERBS — derived from the verb registry", () => {
  const { expected, writeVerbs } = derive();

  it("the derivation can still see what it hunts (non-vacuity)", () => {
    expect(writeVerbs.length).toBeGreaterThan(20);
    expect(expected.has("entity.delete")).toBe(true);
    expect(expected.has("entity.create")).toBe(true);
    // The moment-bound cases the rule must leave ephemeral.
    expect(expected.has("messaging.send")).toBe(false);
    expect(expected.has("feed.post")).toBe(false);
  });

  it("the literal in proposal-class.ts equals the derived set", () => {
    expect([...DURABLE_OBJECT_VERBS].sort()).toEqual([...expected].sort());
  });
});
