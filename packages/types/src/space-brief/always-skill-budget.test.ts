import { describe, it, expect } from "vitest";
import {
  SPACE_ALWAYS_SKILL_BUDGET_TOKENS,
  alwaysSkillBudgetWarning,
  alwaysSkillOverBudget,
  estimateSkillTokens,
} from "./index.js";

describe("always-skill budget", () => {
  it("is 2k tokens, estimated at ~4 chars per token (the IS formula)", () => {
    expect(SPACE_ALWAYS_SKILL_BUDGET_TOKENS).toBe(2_000);
    expect(estimateSkillTokens("abcd")).toBe(1);
    expect(estimateSkillTokens("abcde")).toBe(2);
    expect(estimateSkillTokens("")).toBe(0);
  });

  it("a body at the cap fits; one char over is over", () => {
    expect(alwaysSkillOverBudget("x".repeat(8_000))).toBeNull();
    expect(alwaysSkillOverBudget("x".repeat(8_001))).toEqual({
      tokens: 2_001,
      cap: 2_000,
    });
    expect(alwaysSkillOverBudget(undefined)).toBeNull();
  });

  it("words the warning once, with the skill, the size and the consequence", () => {
    expect(
      alwaysSkillBudgetWarning("system/synap/creative-director", {
        tokens: 5_230,
        cap: 2_000,
      })
    ).toBe(
      "system/synap/creative-director is ~5.2k tokens, over the ~2k always-on budget — it will load on demand"
    );
  });
});
