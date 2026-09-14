import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  ARBITRARY_EXECUTION_EVENT_KEYS,
  DESTRUCTIVE_ACTIONS,
  HUMAN_GATE_EVENT_KEYS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";
// Cross-package SOURCE import, test-only: `@synap-core/types` cannot import the
// engine, so it mirrors the reason-code set and this file is its tripwire.
import { NON_WIDENABLE_GOVERNANCE_REASONS } from "../../types/src/proposals/governance-grant-options.js";

/**
 * B3 — a governance rule on a key behind a non-widenable floor can never fire.
 * `nonWidenableFloorFor` must agree with `decideAgentPolicy` on EVERY floored
 * key, and the frontend mirror of its reason codes must match what it returns.
 *
 * WHAT THIS DOES NOT COVER: context-dependent rungs (2.07, 2.1, 2.55, 2.56) are
 * out by design; a new floor keyed on something other than the event key would
 * not be seen by the scanned set below (the predicate itself would still derive
 * it, because it runs the engine).
 */

// Derived from the engine's own floor lists, never hand-listed here.
const FLOORED_KEYS: string[] = [
  ...ADMIN_ACTIONS,
  ...HUMAN_GATE_EVENT_KEYS,
  ...ARBITRARY_EXECUTION_EVENT_KEYS,
  ...AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  ...AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  ...DESTRUCTIVE_ACTIONS.map((verb) => `entity.${verb}`),
];

describe("nonWidenableFloorFor", () => {
  it("non-vacuity: the scanned floor set is plausibly sized and includes profile.create", () => {
    expect(FLOORED_KEYS.length).toBeGreaterThan(10);
    expect(FLOORED_KEYS).toContain("profile.create");
  });

  it("names a floor for every key whose rule-auto verdict still proposes (behavioural parity)", () => {
    for (const key of FLOORED_KEYS) {
      const dot = key.lastIndexOf(".");
      const engine = decideAgentPolicy({
        subjectType: key.slice(0, dot),
        action: key.slice(dot + 1),
        governanceRuleVerdict: "auto",
      });
      expect(engine.verdict, key).toBe("propose");
      expect(nonWidenableFloorFor(key), key).not.toBeNull();
    }
  });

  it("agent profile.create is the 2.08 floor", () => {
    expect(nonWidenableFloorFor("profile.create")).toBe(
      "AGENT_SCHEMA_DEFINITION"
    );
  });

  it("a widenable key, a glob and a malformed key are null (a rule there can fire)", () => {
    for (const key of [
      "property_def.create",
      "entity.create",
      "automation.execute",
      "*",
      "profile.*",
      "entity.*",
      "create",
      "",
    ]) {
      expect(nonWidenableFloorFor(key), key).toBeNull();
    }
  });

  it("tripwire: the @synap-core/types mirror equals the set of codes the predicate returns", () => {
    const derived = new Set(
      FLOORED_KEYS.map((k) => nonWidenableFloorFor(k)).filter(
        (c): c is string => c !== null
      )
    );
    expect([...derived].sort()).toEqual(
      [...NON_WIDENABLE_GOVERNANCE_REASONS].sort()
    );
  });
});
