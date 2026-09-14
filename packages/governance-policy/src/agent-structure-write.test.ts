import { describe, it, expect } from "vitest";
import {
  AGENT_STRUCTURE_DOOR_CLASS,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  PROPOSE_REASON,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";

/**
 * D1/D2 — an AGENT's structure writes (workspace, cell, renderer promotion,
 * playbook, automation create/activate) ALWAYS propose: no rule, ownership or
 * autoApproveFor wildcard can widen them.
 *
 * Humans never reach `decideAgentPolicy`, so "a human write is unchanged" is a
 * property of the caller, not something this pure engine can witness.
 *
 * WHAT THIS DOES NOT COVER: whether a door actually calls the gate with these
 * keys (the api door tests do), and structure writes a door files under a key
 * outside the classified subjects.
 */

const FLOORED = {
  verdict: "propose",
  reason: PROPOSE_REASON.AGENT_STRUCTURE_WRITE,
  reasonCode: "AGENT_STRUCTURE_WRITE",
} as const;

const split = (key: string) => {
  const dot = key.lastIndexOf(".");
  return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
};

const doorsOf = (cls: string) =>
  Object.entries(AGENT_STRUCTURE_DOOR_CLASS)
    .filter(([, c]) => c === cls)
    .map(([door]) => door.replace("/", "."));

describe("rung 2.09 — agent structure-write floor (D1/D2)", () => {
  it("non-vacuity: the derived key set holds every founder-named write, both spellings", () => {
    for (const key of [
      "workspace.create",
      "cell.define",
      "cell.create",
      "profile.renderer.set",
      "playbook.create",
      "automation.create",
      "automation.activate",
    ]) {
      expect(AGENT_STRUCTURE_WRITE_EVENT_KEYS, key).toContain(key);
    }
    expect(AGENT_STRUCTURE_WRITE_EVENT_KEYS).toContain("workspaces.create");
    expect(AGENT_STRUCTURE_WRITE_EVENT_KEYS.length).toBe(
      doorsOf("floored").length * 2
    );
    expect(doorsOf("floored").length).toBeGreaterThanOrEqual(10);
  });

  for (const key of AGENT_STRUCTURE_WRITE_EVENT_KEYS) {
    it(`${key}: proposes with no signal, and no rule / ownership / wildcard widens it`, () => {
      const pair = split(key);
      expect(decideAgentPolicy(pair)).toEqual(FLOORED);
      expect(
        decideAgentPolicy({ ...pair, governanceRuleVerdict: "auto" })
      ).toEqual(FLOORED);
      expect(
        decideAgentPolicy({ ...pair, isAgentOwnedWorkspace: true })
      ).toEqual(FLOORED);
      expect(
        decideAgentPolicy({
          ...pair,
          autoApproveFor: [`${pair.subjectType}.*`, "*"],
          writesRequireProposal: false,
        })
      ).toEqual(FLOORED);
      expect(nonWidenableFloorFor(key)).toBe("AGENT_STRUCTURE_WRITE");
    });
  }

  it("CBAC deny still wins above the floor", () => {
    expect(
      decideAgentPolicy({
        subjectType: "automation",
        action: "create",
        agentCapabilities: ["entity.*"],
      }).verdict
    ).toBe("deny");
  });

  it("classification is honest: 'other-floor' doors are floored elsewhere, 'widenable' doors are widenable", () => {
    expect(doorsOf("other-floor").length).toBeGreaterThan(0);
    for (const key of doorsOf("other-floor")) {
      const code = nonWidenableFloorFor(key);
      expect(code, key).not.toBeNull();
      expect(code, key).not.toBe("AGENT_STRUCTURE_WRITE");
    }
    expect(doorsOf("widenable").length).toBeGreaterThan(0);
    for (const key of doorsOf("widenable")) {
      expect(nonWidenableFloorFor(key), key).toBeNull();
      expect(
        decideAgentPolicy({ ...split(key), governanceRuleVerdict: "auto" })
      ).toEqual({ verdict: "execute" });
    }
  });

  it("does not over-reach: presentation and runs keep their verdicts", () => {
    expect(
      decideAgentPolicy({ subjectType: "view", action: "create" })
    ).toEqual({ verdict: "execute" });
    expect(
      decideAgentPolicy({
        subjectType: "entity",
        action: "renderer.set",
        governanceRuleVerdict: "auto",
      })
    ).toEqual({ verdict: "execute" });
  });
});
