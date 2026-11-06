/**
 * Agent wake words (the roster's `wake`, plan v2 §3). Each row is pinned, the
 * maps cover exactly the declared values, and an unknown token never leaks.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_WAKE_HOWS,
  AGENT_WAKE_REFUSALS,
  AGENT_WAKE_STATES,
} from "../agents/wake.js";
import {
  AGENT_WAKE_HOW_LABELS,
  AGENT_WAKE_REFUSAL_LABELS,
  AGENT_WAKE_STATE_LABELS,
  resolveAgentWakeHowLabel,
  resolveAgentWakeRefusalLabel,
  resolveAgentWakeStateLabel,
} from "./index.js";

describe("agent wake state words", () => {
  it.each([
    ["awake", "Awake"],
    ["can_wake", "Can wake"],
    ["cant_wake", "Can't wake"],
  ])("%s → %s", (state, words) => {
    expect(resolveAgentWakeStateLabel(state)).toBe(words);
  });

  it("covers exactly the declared states", () => {
    expect(Object.keys(AGENT_WAKE_STATE_LABELS).sort()).toEqual(
      [...AGENT_WAKE_STATES].sort()
    );
  });
});

describe("agent wake path words", () => {
  it.each([
    ["built_in", "Runs in Synap"],
    ["binding", "Started by its connector"],
    ["runner", "Started on its computer"],
  ])("%s → %s", (how, words) => {
    expect(resolveAgentWakeHowLabel(how)).toBe(words);
  });

  it("covers exactly the declared paths", () => {
    expect(Object.keys(AGENT_WAKE_HOW_LABELS).sort()).toEqual(
      [...AGENT_WAKE_HOWS].sort()
    );
  });
});

describe("agent wake refusal words", () => {
  it.each([
    ["paused", "Paused"],
    ["binding_broken", "Connector broken"],
    ["no_template", "No agent template"],
    ["no_template_wake", "Starts only by hand"],
    ["no_computer", "No computer"],
    ["no_waker", "Nothing can start it yet"],
    ["computer_offline", "Computer offline"],
    ["wakes_off", "Waking is off"],
  ])("%s → %s", (why, words) => {
    expect(resolveAgentWakeRefusalLabel(why)).toBe(words);
  });

  it("covers exactly the declared reasons", () => {
    expect(Object.keys(AGENT_WAKE_REFUSAL_LABELS).sort()).toEqual(
      [...AGENT_WAKE_REFUSALS].sort()
    );
  });
});

describe("unknown or absent tokens", () => {
  it("humanize, never leak the raw token; absent is empty", () => {
    expect(resolveAgentWakeStateLabel("half_awake")).toBe("Half awake");
    expect(resolveAgentWakeHowLabel("carrier_pigeon")).toBe("Carrier pigeon");
    expect(resolveAgentWakeRefusalLabel("out_of_coffee")).toBe("Out of coffee");
    expect(resolveAgentWakeStateLabel(null)).toBe("");
    expect(resolveAgentWakeHowLabel(undefined)).toBe("");
    expect(resolveAgentWakeRefusalLabel("")).toBe("");
  });
});
