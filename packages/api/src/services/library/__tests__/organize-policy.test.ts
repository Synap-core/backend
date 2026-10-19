/**
 * An agent's Library organisation (`library/organize`) is ALWAYS a proposal,
 * twice over: the door passes `forcePropose` (rung 2.1), and the event key is
 * a HUMAN GATE (rung 2.05) — both above every widening: an auto rule naming
 * the door, an `autoApproveFor` entry, a session posture. Driven through the
 * REAL engine (`decideAgentPolicy`); the door's own call is pinned in
 * `library.pglite.test.ts`.
 *
 * NOT covered here: the gate's RBAC / key-grant rungs (permission-check
 * suites), and the AI preset grant (ai-preset tripwire, which also checks the
 * door is permitted for an AI key — so its proposal is filed, not denied).
 */
import { describe, expect, it } from "vitest";
import {
  GATE_WRITE_DOORS,
  REVERSIBILITY_DOOR_CLASS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import { LIBRARY_ORGANIZE_DOOR } from "@synap-core/types/imports";

const base = {
  subjectType: LIBRARY_ORGANIZE_DOOR.subjectType,
  action: LIBRARY_ORGANIZE_DOOR.action,
};

describe("library/organize — always a proposal for an agent", () => {
  it("is a declared gate door, classed disruptive (no @reversible rule widens it)", () => {
    expect(GATE_WRITE_DOORS["library/organize"]).toBe("gate");
    expect(REVERSIBILITY_DOOR_CLASS["library/organize"]).toBe("disruptive");
  });

  it("with forcePropose: propose, even when a rule or the agent's whitelist says auto", () => {
    for (const widen of [
      {},
      {
        governanceRuleVerdict: "auto" as const,
        governanceRuleNamesWrite: true,
      },
      { autoApproveFor: ["library.organize", "*"] },
    ]) {
      const v = decideAgentPolicy({
        ...base,
        forcePropose: true,
        ...widen,
      } as never);
      expect(v.verdict, JSON.stringify(widen)).toBe("propose");
    }
  });

  it("without the door's flag too: a human gate no rule, whitelist or default widens", () => {
    for (const widen of [
      {},
      {
        governanceRuleVerdict: "auto" as const,
        governanceRuleNamesWrite: true,
      },
      { autoApproveFor: ["library.organize", "*"] },
    ]) {
      expect(
        decideAgentPolicy({ ...base, ...widen } as never),
        JSON.stringify(widen)
      ).toMatchObject({ verdict: "propose", reasonCode: "HUMAN_GATE" });
    }
    // "Make a rule from this" is refused for it.
    expect(nonWidenableFloorFor("library.organize")).toBe("HUMAN_GATE");
  });
});
