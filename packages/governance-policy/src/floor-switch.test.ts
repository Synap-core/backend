import { describe, it, expect } from "vitest";
import {
  AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
  AGENT_BUILDS_STRUCTURE_EVENT_KEYS,
  AGENT_DEFINES_KINDS_CLASS_PATTERN,
  AGENT_STRUCTURE_WRITE_EVENT_KEYS,
  decideAgentPolicy,
  findMatchingPattern,
  floorClassOf,
} from "./index.js";

/**
 * The two floors a pod may switch: `@agent-defines-kinds` (rung 2.08) and
 * `@agent-builds-structure` (the create / activate half of 2.09). On, the
 * floor YIELDS to the rungs below; it never makes a write `auto` itself, and
 * the rest of 2.09 stays floored.
 *
 * Rows where a naive reading disagrees: a switched-on family with a rule
 * saying auto (the rule decides, not the switch); a switched-on family and no
 * widening signal (still a proposal, for another reason); a 2.09 door outside
 * the family (`cell.define`), which the switch does not touch; the class
 * pattern as a rule (it matches no write).
 */

const split = (key: string) => {
  const dot = key.lastIndexOf(".");
  return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
};

describe("floors a pod may switch", () => {
  it("off (absent), both floors hold even against a rule saying auto", () => {
    for (const key of ["profile.create", "automation.create"]) {
      expect(
        decideAgentPolicy({ ...split(key), governanceRuleVerdict: "auto" })
          .reasonCode,
        key
      ).toMatch(/^AGENT_(SCHEMA_DEFINITION|STRUCTURE_WRITE)$/);
    }
  });

  it("on, the floor yields: a rule below decides", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        governanceRuleVerdict: "auto",
        floorsYield: { agentDefinesKinds: true },
      }).verdict
    ).toBe("execute");
    for (const key of AGENT_BUILDS_STRUCTURE_EVENT_KEYS) {
      expect(
        decideAgentPolicy({
          ...split(key),
          governanceRuleVerdict: "auto",
          floorsYield: { agentBuildsStructure: true },
        }).verdict,
        key
      ).toBe("execute");
    }
  });

  it("on, with no widening signal, it is still a proposal: never a blanket auto", () => {
    const decided = decideAgentPolicy({
      subjectType: "playbook",
      action: "create",
      floorsYield: { agentBuildsStructure: true },
    });
    expect(decided.verdict).toBe("propose");
    expect(decided.reasonCode).not.toBe("AGENT_STRUCTURE_WRITE");
  });

  it("one family's switch does not yield the other's floor", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        governanceRuleVerdict: "auto",
        floorsYield: { agentBuildsStructure: true },
      }).reasonCode
    ).toBe("AGENT_SCHEMA_DEFINITION");
  });

  it("the rest of 2.09 stays floored when the structure family is on", () => {
    const outside = AGENT_STRUCTURE_WRITE_EVENT_KEYS.filter(
      (k) => !AGENT_BUILDS_STRUCTURE_EVENT_KEYS.includes(k)
    );
    expect(outside).toContain("cell.define");
    for (const key of outside) {
      expect(
        decideAgentPolicy({
          ...split(key),
          governanceRuleVerdict: "auto",
          floorsYield: { agentBuildsStructure: true, agentDefinesKinds: true },
        }).reasonCode,
        key
      ).toBe("AGENT_STRUCTURE_WRITE");
    }
  });

  it("the family holds both spellings of each yielded door", () => {
    for (const key of [
      "playbook.create",
      "automations.create",
      "workspace.create",
      "automation.activate",
    ]) {
      expect(floorClassOf(key), key).toBe(AGENT_BUILDS_STRUCTURE_CLASS_PATTERN);
    }
    expect(floorClassOf("profile.create")).toBe(
      AGENT_DEFINES_KINDS_CLASS_PATTERN
    );
    expect(floorClassOf("cell.define")).toBeNull();
  });

  it("a class pattern as a rule matches no write", () => {
    for (const pattern of [
      AGENT_DEFINES_KINDS_CLASS_PATTERN,
      AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
    ]) {
      expect(findMatchingPattern("playbook.create", [pattern])).toBeUndefined();
      expect(findMatchingPattern(pattern, [pattern])).toBeUndefined();
    }
  });
});
