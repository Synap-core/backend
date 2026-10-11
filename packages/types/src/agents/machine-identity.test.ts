import { describe, it, expect } from "vitest";
import {
  agentDisplayName,
  AGENT_DIRECTION_BY_ORIGIN,
  MACHINE_AGENT_TYPE,
  resolveAgentDirection,
} from "./index.js";
import { resolveObjectNoun } from "../vocabulary/index.js";

describe("computer identity words", () => {
  it("names a hosted agent by its computer", () => {
    expect(agentDisplayName({ name: "Claude Code", hostName: "devbox" })).toBe(
      "Claude Code on devbox"
    );
  });

  it("keeps an agent with no computer as it is", () => {
    expect(agentDisplayName({ name: "Claude Code", hostName: null })).toBe(
      "Claude Code"
    );
    expect(agentDisplayName({ name: "Claude Code", hostName: "  " })).toBe(
      "Claude Code"
    );
  });

  it("never renders an empty name", () => {
    expect(agentDisplayName({ name: null, hostName: "devbox" })).toBe(
      "Agent on devbox"
    );
  });

  it("calls a machine a Computer", () => {
    expect(resolveObjectNoun(MACHINE_AGENT_TYPE)).toBe("Computer");
  });

  it("classifies a device-approved computer as the person's own", () => {
    expect(AGENT_DIRECTION_BY_ORIGIN.device).toBe("external");
    expect(resolveAgentDirection({ origin: "device" })).toBe("external");
  });
});
