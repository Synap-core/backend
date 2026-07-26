import { describe, expect, it } from "vitest";
import { channelSendMessageInputSchema } from "./channels.js";

const baseInput = {
  content: "Help me set up this workspace",
};

describe("channel onboarding skill allowlist", () => {
  it.each(["onboard", "agent-os"] as const)(
    "accepts the first-party %s workflow",
    (onboardingSkill) => {
      expect(
        channelSendMessageInputSchema.safeParse({
          ...baseInput,
          onboardingSkill,
        }).success
      ).toBe(true);
    }
  );

  it("rejects arbitrary skill names", () => {
    expect(
      channelSendMessageInputSchema.safeParse({
        ...baseInput,
        onboardingSkill: "system/custom/skill",
      }).success
    ).toBe(false);
  });
});
