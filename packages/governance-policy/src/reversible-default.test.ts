import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  GATE_WRITE_DOORS,
  REVERSIBILITY_DOOR_CLASS,
  REVERSIBLE_CLASS_PATTERN,
  REVERSIBLE_EVENT_KEYS,
  decideAgentPolicy,
  findMatchingPattern,
  isReversibleWrite,
  matchesActionPattern,
  nonWidenableFloorFor,
} from "./index.js";

/**
 * "Reversible writes act" (founder, 2026-09-28): the pod default is ONE
 * `governance_rules` row with pattern `@reversible`, verdict auto, resolved at
 * rung 2.8. These tests pin the CLASS against the engine's floors.
 *
 * WHAT THIS DOES NOT COVER: the context-dependent rungs (2.07 pod-admin
 * schema, 2.1 forcePropose, 2.55 origin, 2.56 ceiling) — they fire on per-write
 * facts the class cannot see, and they return BEFORE rung 2.8, so a reversible
 * key carrying them still proposes (asserted once below for 2.1).
 */

// Derived: every door the gate knows, from the engine's own registry.
const ALL_DOORS = Object.keys(GATE_WRITE_DOORS);
const keyOf = (door: string) => door.replace("/", ".");
const split = (key: string) => {
  const dot = key.indexOf(".");
  return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
};

describe("reversibility class — coverage", () => {
  it("classifies every gate door (non-vacuous)", () => {
    expect(ALL_DOORS.length).toBeGreaterThan(80);
    expect(Object.keys(REVERSIBILITY_DOOR_CLASS).sort()).toEqual(
      [...ALL_DOORS].sort()
    );
    expect(REVERSIBLE_EVENT_KEYS.length).toBeGreaterThanOrEqual(20);
    expect(REVERSIBLE_EVENT_KEYS).toContain("entity.create");
    expect(REVERSIBLE_EVENT_KEYS).toContain("entity.update");
  });

  it("never calls a floored key reversible (the floors would win anyway)", () => {
    for (const key of REVERSIBLE_EVENT_KEYS) {
      expect({ key, floor: nonWidenableFloorFor(key) }).toEqual({
        key,
        floor: null,
      });
      expect(ADMIN_ACTIONS.includes(key)).toBe(false);
      expect(DESTRUCTIVE_ACTIONS.includes(split(key).action)).toBe(false);
    }
  });

  it("is fail-closed for keys that are not gate doors", () => {
    expect(isReversibleWrite("entity.delete")).toBe(false);
    expect(isReversibleWrite("secret.create")).toBe(false);
    expect(isReversibleWrite("*")).toBe(false);
    expect(isReversibleWrite(REVERSIBLE_CLASS_PATTERN)).toBe(false);
  });
});

describe("the @reversible class pattern", () => {
  it("matches reversible writes and nothing else", () => {
    expect(REVERSIBLE_CLASS_PATTERN).toBe("@reversible");
    expect(matchesActionPattern("entity.update", ["@reversible"])).toBe(true);
    expect(findMatchingPattern("document.update", ["@reversible"])).toBe(
      "@reversible"
    );
    expect(matchesActionPattern("entity.delete", ["@reversible"])).toBe(false);
    expect(matchesActionPattern("share.create", ["@reversible"])).toBe(false);
    expect(matchesActionPattern("tool.create", ["@reversible"])).toBe(false);
  });
});

/**
 * THE FLOOR TRIPWIRE for the pod default: an `auto` rule at rung 2.8 — which is
 * what the `@reversible` row resolves to for a matching key — can NEVER
 * auto-approve a floored key, and a strict agent (`writesRequireProposal`)
 * acts directly on every reversible key. Driven over EVERY gate door.
 */
describe("decideAgentPolicy with the pod default resolved", () => {
  for (const door of ALL_DOORS) {
    const key = keyOf(door);
    const { subjectType, action } = split(key);
    const reversible = isReversibleWrite(key);
    it(`${key} → ${reversible ? "execute" : "not widened by the class"}`, () => {
      const verdict = decideAgentPolicy({
        subjectType,
        action,
        writesRequireProposal: true,
        // The resolver returns the class row's verdict only for a match.
        governanceRuleVerdict: matchesActionPattern(key, ["@reversible"])
          ? "auto"
          : undefined,
      }).verdict;
      if (reversible) expect(verdict).toBe("execute");
      else expect(verdict).not.toBe("execute");
      if (nonWidenableFloorFor(key) !== null) {
        // Even a rule that DID say auto cannot move a floor.
        expect(
          decideAgentPolicy({
            subjectType,
            action,
            governanceRuleVerdict: "auto",
          }).verdict
        ).toBe("propose");
      }
    });
  }

  it("a scope/identity change on a reversible key still proposes (2.1)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "update",
        governanceRuleVerdict: "auto",
        forcePropose: true,
      }).verdict
    ).toBe("propose");
  });
});
