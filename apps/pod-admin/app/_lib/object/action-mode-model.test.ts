import { describe, expect, it } from "vitest";
import { actionModeChoices, isActionRunMode } from "./action-mode-model";

describe("actionModeChoices — how one action runs, as a tool's page offers it", () => {
  it("offers the three modes in the pod's order, in the vocabulary's words", () => {
    const choices = actionModeChoices({ type: "read", mayRunOnItsOwn: true });
    expect(choices.map((c) => [c.mode, c.label])).toEqual([
      ["auto", "Runs on its own"],
      ["ask", "Asks first"],
      ["never", "Never"],
    ]);
    expect(choices.every((c) => !c.disabled)).toBe(true);
  });

  it("says plainly that an action that sends goes without asking", () => {
    const [auto] = actionModeChoices({ type: "action", mayRunOnItsOwn: true });
    expect(auto?.line).toMatch(/outside your pod/);
    const [readAuto] = actionModeChoices({
      type: "read",
      mayRunOnItsOwn: true,
    });
    expect(readAuto?.line).toMatch(/only reads/);
  });

  it("a public post can never run on its own: that choice is disabled and says why", () => {
    const choices = actionModeChoices({
      type: "action",
      mayRunOnItsOwn: false,
    });
    const auto = choices.find((c) => c.mode === "auto");
    expect(auto?.disabled).toBe(true);
    expect(auto?.line).toMatch(/always asks/);
    expect(choices.filter((c) => c.disabled)).toHaveLength(1);
  });

  it("isActionRunMode accepts the three modes only", () => {
    expect(["auto", "ask", "never"].every(isActionRunMode)).toBe(true);
    expect(isActionRunMode("propose")).toBe(false);
    expect(isActionRunMode(undefined)).toBe(false);
  });
});
