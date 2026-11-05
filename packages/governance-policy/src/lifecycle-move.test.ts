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

  // Founder, 2026-11-05 (plan b38e5e64 §7.2): a session END move is governed
  // like any write of the closer; the session having to end is its guardrail,
  // so the done/lost default does not apply — but a `propose` rule (an "ask
  // first" agent) and the humanOnly floor still do.
  it("a session END move into done/lost skips the 2.85 default, and nothing else", () => {
    const endMove = {
      intoTerminal: true,
      humanOnly: false,
      atSessionEnd: true,
    };
    expect(decideAgentPolicy({ ...base, lifecycleMove: endMove })).toEqual({
      verdict: "execute",
    });
    // an "ask first" agent: a propose rule still proposes
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: endMove,
        governanceRuleVerdict: "propose",
        governanceRuleId: "rule-ask-first",
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "GOVERNANCE_RULE" });
    // a broad auto rule applies like on any other write
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: endMove,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-reversible-class",
        governanceRuleNamesWrite: false,
      })
    ).toEqual({
      verdict: "execute",
      governanceRuleId: "rule-reversible-class",
    });
    // the humanOnly floor holds, whatever the rule
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { ...endMove, humanOnly: true },
        governanceRuleVerdict: "auto",
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "HUMAN_ONLY_STATUS" });
    // the same move WITHOUT the flag still proposes (stage moves keep 2.85)
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
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

  it("transition needs write permission", () => {
    expect(requiredPermissionFor("transition")).toBe("write");
  });
});
