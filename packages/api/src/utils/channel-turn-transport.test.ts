import { describe, expect, it } from "vitest";
import { withTurnStreamSignal } from "./channel-turn-transport.js";

describe("channel turn transport parity", () => {
  it("adds only cancellation to the fallback-compatible request", () => {
    const baseRequest = {
      projectId: "project-id",
      workspaceId: "workspace-id",
      deepAnalysis: true,
      forcedSkillName: "onboard",
      turnContext: { entries: [{ key: "surface", value: "crm" }] },
      workspaceSettings: { agentModelPreferences: { quality: "high" } },
    };
    const controller = new AbortController();
    const streamRequest = withTurnStreamSignal(baseRequest, controller.signal);

    const { signal, ...withoutSignal } = streamRequest;
    expect(signal).toBe(controller.signal);
    expect(withoutSignal).toEqual(baseRequest);
  });
});
