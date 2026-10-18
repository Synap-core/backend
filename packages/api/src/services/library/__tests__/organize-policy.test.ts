/**
 * An agent's Library organisation (`library/organize`) is ALWAYS a proposal:
 * the door passes `forcePropose`, and the pure engine's rung 2.1 sits above
 * every widening — an auto rule naming the door, an `autoApproveFor` entry, a
 * session posture. Driven through the REAL engine (`decideAgentPolicy`) with
 * the flag the door sends; the door's own call is pinned in
 * `library.pglite.test.ts` (4B).
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

  it("CONTROL: without the door's flag, an auto rule WOULD execute it — the flag is what holds", () => {
    const v = decideAgentPolicy({
      ...base,
      governanceRuleVerdict: "auto",
      governanceRuleNamesWrite: true,
    } as never);
    expect(v.verdict).toBe("execute");
  });
});
