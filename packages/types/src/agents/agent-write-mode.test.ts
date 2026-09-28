import { describe, it, expect } from "vitest";
import { AGENT_WRITE_MODE_LINE, resolveAgentWriteMode } from "./index.js";

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
