/**
 * Agent reach + binding-error words (agents Synap can dispatch work to, W5).
 * Each row is pinned, and the unknown fallbacks never leak a raw token.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_BINDING_ERROR_LABELS,
  AGENT_REACH_LABELS,
  resolveAgentBindingErrorLabel,
  resolveAgentReachLabel,
} from "./index.js";

describe("agent reach words", () => {
  it.each([
    ["pod", "Runs in Synap"],
    ["dispatch", "Synap sends it work"],
    ["pull", "Connects in"],
  ])("%s → %s", (reach, words) => {
    expect(resolveAgentReachLabel(reach)).toBe(words);
  });

  it("covers exactly the three reaches", () => {
    expect(Object.keys(AGENT_REACH_LABELS).sort()).toEqual([
      "dispatch",
      "pod",
      "pull",
    ]);
  });

  it("an unknown reach humanizes, an absent one is empty", () => {
    expect(resolveAgentReachLabel("over_the_air")).toBe("Over the air");
    expect(resolveAgentReachLabel(null)).toBe("");
  });
});

describe("agent binding error words", () => {
  it.each([
    ["ambiguous", "Several connectors"],
    ["tool_missing", "Connector removed"],
    ["tool_inactive", "Connector off"],
    ["not_an_agent_tool", "Not an agent connector"],
    ["malformed", "Connector misconfigured"],
  ])("%s → %s", (code, words) => {
    expect(resolveAgentBindingErrorLabel(code)).toBe(words);
  });

  it("an unknown or absent code still reads as broken, never the raw code", () => {
    expect(resolveAgentBindingErrorLabel("quota_exceeded")).toBe(
      "Connector broken"
    );
    expect(resolveAgentBindingErrorLabel(undefined)).toBe("Connector broken");
    expect(Object.keys(AGENT_BINDING_ERROR_LABELS)).toHaveLength(5);
  });
});
