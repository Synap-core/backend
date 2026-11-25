/**
 * Work model W14 — the lifecycle floor in `decideAgentPolicy`:
 *  - a human-only option ALWAYS proposes, even under an "auto" rule (2.075);
 *  - a move into done/lost proposes BY DEFAULT, and only a rule that NAMES
 *    the write may widen it — never a class/glob/profile-wide rule (2.8/2.85);
 *  - any other move executes once attributed (2.86), still under the origin /
 *    ceiling floors above it.
 */
import { describe, it, expect } from "vitest";
import { decideAgentPolicy, requiredPermissionFor } from "./index.js";

const base = { subjectType: "entity", action: "transition" } as const;

describe("lifecycle move governance", () => {
  it("human-only options propose and no rule can widen them", () => {
    const v = decideAgentPolicy({
      ...base,
      lifecycleMove: { intoTerminal: true, humanOnly: true },
      governanceRuleVerdict: "auto",
    });
    expect(v).toMatchObject({
      verdict: "propose",
      reasonCode: "HUMAN_ONLY_STATUS",
    });
  });

  it("a move into done/lost proposes by default; a rule NAMING the write widens it", () => {
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_TERMINAL" });
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-explicit-transition",
        governanceRuleNamesWrite: true,
      })
    ).toEqual({
      verdict: "execute",
      governanceRuleId: "rule-explicit-transition",
    });
    // ownership does NOT decide it (rung 3 sits below)
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
        isAgentOwnedWorkspace: true,
      }).verdict
    ).toBe("propose");
  });

  // Dogfood 2026-10-12, proposal 66f24f68: the pod's `@reversible` class row
  // auto-approved Briefed → Published. A rule that does not name the write
  // (class, glob, `*`, profile-wide — or a caller that never said) must not
  // widen a terminal move; it falls to 2.85.
  it("a broad auto rule (e.g. @reversible) does NOT widen a move into done/lost", () => {
    for (const governanceRuleNamesWrite of [false, undefined]) {
      expect(
        decideAgentPolicy({
          ...base,
          lifecycleMove: { intoTerminal: true, humanOnly: false },
          governanceRuleVerdict: "auto",
          governanceRuleId: "rule-reversible-class",
          governanceRuleNamesWrite,
          // even a strict agent's ownership/whitelist rungs sit below 2.85
          isAgentOwnedWorkspace: true,
        })
      ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_TERMINAL" });
    }
  });

  // A session's end moves nothing (decision 5e377b06; plan 73fa04b5 D1), so
  // no move skips the done/lost floor any more: the retired `atSessionEnd`
  // exemption is gone, and a caller that still sends it is not obeyed.
  it("the done/lost floor holds at a session's close too (no end-move exemption)", () => {
    const staleEndMove = {
      intoTerminal: true,
      humanOnly: false,
      atSessionEnd: true,
    } as unknown as { intoTerminal: boolean; humanOnly: boolean };
    expect(
      decideAgentPolicy({ ...base, lifecycleMove: staleEndMove })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_TERMINAL" });
    // a broad auto rule does not widen it either (2.85 holds)
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: staleEndMove,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-reversible-class",
        governanceRuleNamesWrite: false,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_TERMINAL" });
  });

  it("a broad auto rule still widens a NON-terminal move", () => {
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: false, humanOnly: false },
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-reversible-class",
        governanceRuleNamesWrite: false,
        writesRequireProposal: true,
      })
    ).toEqual({
      verdict: "execute",
      governanceRuleId: "rule-reversible-class",
    });
  });

  it("a broad PROPOSE rule still tightens a terminal move (reason = the rule)", () => {
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
        governanceRuleVerdict: "propose",
        governanceRuleNamesWrite: false,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "GOVERNANCE_RULE" });
  });

  it("a non-terminal move executes, but the origin floor still applies", () => {
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: false, humanOnly: false },
        writesRequireProposal: true,
      }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: false, humanOnly: false },
        originTrust: "untrusted",
      }).verdict
    ).toBe("propose");
  });

  // Finding 2d84febb: a session BIRTH (a session started into a playbook's
  // first stage) on a thing already done or lost reopened it with no
  // proposal. A birth that reopens always proposes, whatever the rule; a
  // reopen that is not a birth, and a birth that reopens nothing, keep 2.86.
  it("a session BIRTH move out of done/lost always proposes, and nothing else does", () => {
    const birthReopen = {
      intoTerminal: false,
      humanOnly: false,
      outOfTerminal: true,
      atSessionBirth: true,
    };
    expect(
      decideAgentPolicy({ ...base, lifecycleMove: birthReopen })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_REOPEN" });
    // no rule widens it, not even one naming the write
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: birthReopen,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-explicit-transition",
        governanceRuleNamesWrite: true,
        isAgentOwnedWorkspace: true,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_REOPEN" });
    // a birth that reopens nothing executes (the first stage of an open thing)
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { ...birthReopen, outOfTerminal: false },
      })
    ).toEqual({ verdict: "execute" });
    // a reopen that is not a birth (an agent's own move, a stage advance)
    // executes as before
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { ...birthReopen, atSessionBirth: undefined },
      })
    ).toEqual({ verdict: "execute" });
  });

  it("transition needs write permission", () => {
    expect(requiredPermissionFor("transition")).toBe("write");
  });
});
