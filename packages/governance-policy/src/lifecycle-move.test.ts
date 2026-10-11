/**
 * Work model W14 — the lifecycle floor in `decideAgentPolicy`:
 *  - a human-only option ALWAYS proposes, even under an "auto" rule (2.075);
 *  - a move into done/lost proposes BY DEFAULT, but a rule may widen it (2.85);
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

  it("a move into done/lost proposes by default; an auto rule widens it", () => {
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
      }).verdict
    ).toBe("execute");
    // ownership does NOT decide it (rung 3 sits below)
    expect(
      decideAgentPolicy({
        ...base,
        lifecycleMove: { intoTerminal: true, humanOnly: false },
        isAgentOwnedWorkspace: true,
      }).verdict
    ).toBe("propose");
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
