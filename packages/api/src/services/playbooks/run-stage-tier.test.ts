import { describe, it, expect } from "vitest";
import { activeStageTier } from "./run-stage-tier.js";
import {
  resolveRunToolProfile,
  type RunToolProfileDeps,
} from "./run-tool-profile.js";

const STAGES = [
  { key: "read", tier: "quick" },
  { key: "diagnose", tier: "deep" },
  { key: "plain" },
  { key: "typo", tier: "Deep" },
];

describe("activeStageTier", () => {
  it("is the active stage's tier", () => {
    expect(activeStageTier(STAGES, "diagnose")).toBe("deep");
    expect(activeStageTier(STAGES, "read")).toBe("quick");
  });

  it("is absent with no stage, no tier, or a value outside the closed set", () => {
    expect(activeStageTier(STAGES, null)).toBeUndefined();
    expect(activeStageTier(STAGES, "missing")).toBeUndefined();
    expect(activeStageTier(STAGES, "plain")).toBeUndefined();
    expect(activeStageTier(STAGES, "typo")).toBeUndefined();
    expect(activeStageTier("not a list", "read")).toBeUndefined();
  });
});

describe("resolveRunToolProfile carries the active stage's tier", () => {
  function deps(currentStage: string | null): RunToolProfileDeps {
    return {
      readPlaybook: async () => ({
        name: "Improve a recipe",
        tools: [],
        executor: "is-agent",
        stages: STAGES,
        workspaceId: null,
      }),
      readCurrentStage: async () => currentStage,
      readTrial: async () => false,
      readRegistry: async () => ({ index: new Map(), capabilities: [] }),
    };
  }
  const input = {
    playbookId: "pb-1",
    workspaceId: null,
    userId: "u-1",
    sessionId: "s-1",
  };

  it("sends the tier of the stage the session is in", async () => {
    const profile = await resolveRunToolProfile(input, deps("diagnose"));
    expect(profile.tier).toBe("deep");
  });

  it("sends no tier when the stage declares none", async () => {
    const profile = await resolveRunToolProfile(input, deps("plain"));
    expect(profile).not.toHaveProperty("tier");
  });
});
