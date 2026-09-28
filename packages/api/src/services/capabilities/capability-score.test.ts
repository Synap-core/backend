import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreCapabilityVerb } from "./capability-score.js";

describe("scoreCapabilityVerb", () => {
  it("counts a provider error as a failure and leaves a rejection beside the score", () => {
    expect(
      scoreCapabilityVerb({ delivered: 3, errors: 1, rejected: 2 })
    ).toEqual({
      calls: 4,
      failures: 1,
      rejections: 2,
      reliability: 0.75,
    });
  });

  it("has no reliability until something has run", () => {
    expect(
      scoreCapabilityVerb({ delivered: 0, errors: 0, rejected: 4 }).reliability
    ).toBeNull();
  });

  it("is not an input to decideAgentPolicy", () => {
    const policy = readFileSync(
      new URL("../../../../governance-policy/src/index.ts", import.meta.url),
      "utf8"
    );
    expect(policy).not.toContain("scoreCapabilityVerb");
    expect(policy).not.toContain("capability_intents");
    expect(policy).not.toContain("capability_run");
  });
});
