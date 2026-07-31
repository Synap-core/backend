import { describe, expect, it } from "vitest";
import {
  decideChatTurnClaimAction,
  isUsefulAssistantContent,
  stableUuidFromSeed,
} from "./chat-turn-store.js";

describe("stableUuidFromSeed", () => {
  it("returns a stable UUID for the same Discord seed", () => {
    const seed = "discord-channel-1:123456789012345678";
    const a = stableUuidFromSeed(seed);
    const b = stableUuidFromSeed(seed);
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("differs for different seeds", () => {
    expect(stableUuidFromSeed("a:1")).not.toBe(stableUuidFromSeed("a:2"));
  });
});

describe("isUsefulAssistantContent", () => {
  it("rejects empty / whitespace / null", () => {
    expect(isUsefulAssistantContent(null)).toBe(false);
    expect(isUsefulAssistantContent(undefined)).toBe(false);
    expect(isUsefulAssistantContent("")).toBe(false);
    expect(isUsefulAssistantContent("   ")).toBe(false);
  });

  it("accepts non-empty body", () => {
    expect(isUsefulAssistantContent("hello")).toBe(true);
    expect(isUsefulAssistantContent(" partial ")).toBe(true);
  });
});

describe("decideChatTurnClaimAction (D5 reopen policy)", () => {
  it("runs a newly created claim", () => {
    expect(
      decideChatTurnClaimAction({
        created: true,
        status: "running",
        hasUsefulAssistant: false,
      })
    ).toBe("run");
  });

  it("skips completed (even without assistant content)", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "completed",
        hasUsefulAssistant: false,
      })
    ).toBe("skip_completed");
  });

  it("reports in_progress for concurrent running claim", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "running",
        hasUsefulAssistant: false,
      })
    ).toBe("in_progress");
  });

  it("reopens failed turn when no useful assistant", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "failed",
        hasUsefulAssistant: false,
      })
    ).toBe("reopen_and_run");
  });

  it("skips failed turn when useful assistant already exists", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "failed",
        hasUsefulAssistant: true,
      })
    ).toBe("skip_with_assistant");
  });

  it("does not auto-reopen cancelled without assistant", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "cancelled",
        hasUsefulAssistant: false,
      })
    ).toBe("skip_cancelled");
  });

  it("surfaces cancelled with assistant content", () => {
    expect(
      decideChatTurnClaimAction({
        created: false,
        status: "cancelled",
        hasUsefulAssistant: true,
      })
    ).toBe("skip_with_assistant");
  });
});
