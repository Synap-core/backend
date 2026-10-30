/**
 * Rung 1.5 — a person's "Never" (founder decision G3, 0381). A `deny` rule the
 * caller resolved refuses the write with the typed `DENIED_BY_RULE`, above
 * every floor (refusing never loosens one), below CBAC (which already denies).
 * Without a deny rule, every verdict is the one the ladder gave before.
 */
import { describe, it, expect } from "vitest";
import {
  decideAgentPolicy,
  DENIED_BY_RULE,
  DENIED_BY_RULE_REASON,
} from "./index.js";

const update = { subjectType: "entity", action: "update" } as const;

describe("decideAgentPolicy — a deny rule (rung 1.5)", () => {
  it("refuses a write the default would execute, typed", () => {
    expect(decideAgentPolicy(update).verdict).toBe("execute");
    expect(
      decideAgentPolicy({ ...update, governanceRuleVerdict: "deny" })
    ).toEqual({
      verdict: "deny",
      reason: DENIED_BY_RULE_REASON,
      reasonCode: DENIED_BY_RULE,
    });
  });

  it("the reason text opens with the code, for doors that forward only text", () => {
    expect(DENIED_BY_RULE_REASON.startsWith(`${DENIED_BY_RULE}:`)).toBe(true);
  });

  it("refuses above the destructive floor (a floor proposes; Never refuses)", () => {
    const del = { subjectType: "entity", action: "delete" } as const;
    expect(decideAgentPolicy(del).verdict).toBe("propose");
    expect(
      decideAgentPolicy({ ...del, governanceRuleVerdict: "deny" }).verdict
    ).toBe("deny");
  });

  it("refuses above the admin floor", () => {
    const admin = { subjectType: "workspace", action: "delete" } as const;
    expect(decideAgentPolicy(admin).verdict).toBe("propose");
    expect(
      decideAgentPolicy({ ...admin, governanceRuleVerdict: "deny" })
    ).toMatchObject({ verdict: "deny", reasonCode: DENIED_BY_RULE });
  });

  it("refuses a capability run whose grant says auto", () => {
    expect(
      decideAgentPolicy({
        subjectType: "capability",
        action: "run",
        capabilityGovernance: "auto",
        governanceRuleVerdict: "deny",
      })
    ).toMatchObject({ verdict: "deny", reasonCode: DENIED_BY_RULE });
  });

  it("CBAC still denies first, with its own reason (no code)", () => {
    const verdict = decideAgentPolicy({
      ...update,
      agentCapabilities: ["entity.create"],
      governanceRuleVerdict: "deny",
    });
    expect(verdict.verdict).toBe("deny");
    expect(verdict).not.toHaveProperty("reasonCode");
  });

  it("an auto or propose rule is unchanged by the new rung", () => {
    expect(
      decideAgentPolicy({ ...update, governanceRuleVerdict: "auto" }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({ ...update, governanceRuleVerdict: "propose" }).verdict
    ).toBe("propose");
  });
});
