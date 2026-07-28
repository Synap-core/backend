import { describe, expect, it } from "vitest";
import { stableUuidFromSeed } from "./chat-turn-store.js";

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
