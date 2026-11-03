import { describe, it, expect } from "vitest";
import {
  AGENT_WRITE_MODE_CHOICES,
  AGENT_WRITE_MODE_LINE,
  agentPostureOfWriteMode,
  isAgentWriteMode,
  resolveAgentWriteMode,
} from "./index.js";

describe("resolveAgentWriteMode", () => {
  it("an agent's own override wins over the pod default", () => {
    expect(
      resolveAgentWriteMode({
        posture: "ask-first",
        podDefaultEnabled: true,
        writesRequireProposal: true,
      })
    ).toBe("ask-first");
    expect(
      resolveAgentWriteMode({
        posture: "create-with-undo",
        podDefaultEnabled: true,
        writesRequireProposal: true,
      })
    ).toBe("create-with-undo");
  });

  it("no override: the pod default decides — the legacy flag is NOT read while it is on", () => {
    expect(
      resolveAgentWriteMode({
        posture: null,
        podDefaultEnabled: true,
        writesRequireProposal: true,
      })
    ).toBe("pod-default");
  });

  it("pod default off: a strict agent asks for everything", () => {
    expect(
      resolveAgentWriteMode({
        posture: null,
        podDefaultEnabled: false,
        writesRequireProposal: true,
      })
    ).toBe("ask-first");
    expect(
      resolveAgentWriteMode({
        posture: undefined,
        podDefaultEnabled: false,
        writesRequireProposal: false,
      })
    ).toBe("pod-default");
  });

  it("states the truth in one sentence per mode", () => {
    expect(AGENT_WRITE_MODE_LINE["pod-default"]).toBe(
      "Creates and edits apply directly with Undo; deletions and structural changes ask you."
    );
    expect(AGENT_WRITE_MODE_LINE["ask-first"]).toBe(
      "Every change asks you first."
    );
  });
});

describe("AGENT_WRITE_MODE_CHOICES — the one list every surface offers", () => {
  it("offers every mode once, the normal one first and recommended", () => {
    expect(AGENT_WRITE_MODE_CHOICES.map((c) => c.mode)).toEqual([
      "pod-default",
      "create-with-undo",
      "ask-first",
    ]);
    expect(
      AGENT_WRITE_MODE_CHOICES.filter((c) => c.recommended).map((c) => c.mode)
    ).toEqual(["pod-default"]);
    for (const c of AGENT_WRITE_MODE_CHOICES)
      expect(c.line).toBe(AGENT_WRITE_MODE_LINE[c.mode]);
  });

  it("stores the normal mode as no posture, the others as their posture", () => {
    expect(agentPostureOfWriteMode("pod-default")).toBeNull();
    expect(agentPostureOfWriteMode("create-with-undo")).toBe(
      "create-with-undo"
    );
    expect(agentPostureOfWriteMode("ask-first")).toBe("ask-first");
  });

  it("knows its own modes and nothing else", () => {
    expect(isAgentWriteMode("ask-first")).toBe(true);
    expect(isAgentWriteMode("normal")).toBe(false);
    expect(isAgentWriteMode(null)).toBe(false);
  });
});
