import { describe, it, expect } from "vitest";
import { resolveHandedToLabel } from "./index.js";

describe("resolveHandedToLabel — who holds a handed-off slot", () => {
  it("names the agent by its catalogue name when the surface has it", () => {
    expect(resolveHandedToLabel("growth_scout", "Scout")).toBe(
      "Handed to Scout"
    );
  });

  it("humanizes the agent TYPE token, never leaks it", () => {
    // Rule ruled out: Relay's raw "With growth_scout".
    expect(resolveHandedToLabel("growth_scout")).toBe("Handed to Growth scout");
    expect(resolveHandedToLabel("researcher", "  ")).toBe(
      "Handed to Researcher"
    );
  });

  it("is PAST mood: the hand-off already happened", () => {
    expect(resolveHandedToLabel("researcher")).toMatch(/^Handed to /);
  });
});
