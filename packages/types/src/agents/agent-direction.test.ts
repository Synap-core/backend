import { describe, expect, it } from "vitest";
import {
  AGENT_DIRECTION_BY_ORIGIN,
  AGENT_ORIGINS,
  agentDirectionOf,
  resolveAgentDirection,
} from "./index";

/**
 * The rows that matter are the ones where direction and `builtIn` DISAGREE —
 * `builtIn` is "pod-made AND never keyed", so a keyed IS persona is
 * `builtIn: false` and listed as the person's own agent. That row is the defect
 * this rule exists for; a table without it would pass with the old rule.
 */
describe("resolveAgentDirection — whose agent is this", () => {
  it("an IS persona is the pod's own even though it holds a key (the defect row)", () => {
    // builtIn would be false here (keyed) — direction must still say house.
    expect(
      resolveAgentDirection({
        origin: "intelligence-service",
        isPersonalAgent: false,
      })
    ).toBe("house");
  });

  it("the pod's own system agents are house", () => {
    expect(resolveAgentDirection({ origin: "system" })).toBe("house");
  });

  it("the twin is house even with no origin stamped", () => {
    expect(resolveAgentDirection({ origin: null, isPersonalAgent: true })).toBe(
      "house"
    );
  });

  it("agents a person brought or made are external", () => {
    expect(resolveAgentDirection({ origin: "cli" })).toBe("external");
    expect(
      resolveAgentDirection({ origin: "ui", isPersonalAgent: false })
    ).toBe("external");
  });

  it("no origin, or one this build does not know, is shown as the person's (never hidden)", () => {
    expect(resolveAgentDirection({ origin: null })).toBe("external");
    expect(resolveAgentDirection({ origin: undefined })).toBe("external");
    expect(resolveAgentDirection({ origin: "some-future-door" })).toBe(
      "external"
    );
    // A prototype key is not an origin.
    expect(resolveAgentDirection({ origin: "toString" })).toBe("external");
  });

  it("every declared origin is classified (runtime mirror of the compile floor)", () => {
    expect(AGENT_ORIGINS.length).toBeGreaterThanOrEqual(4);
    for (const origin of AGENT_ORIGINS) {
      expect(["external", "house"]).toContain(
        AGENT_DIRECTION_BY_ORIGIN[origin]
      );
    }
    expect(Object.keys(AGENT_DIRECTION_BY_ORIGIN).sort()).toEqual(
      [...AGENT_ORIGINS].sort()
    );
  });
});

describe("agentDirectionOf — a served roster row", () => {
  it("the pod's direction wins over what origin alone would say", () => {
    // Discriminating row: origin alone reads external; the pod said house.
    expect(agentDirectionOf({ direction: "house", origin: null })).toBe(
      "house"
    );
  });
  it("no direction (older pod) ⇒ derived from origin", () => {
    expect(agentDirectionOf({ origin: "intelligence-service" })).toBe("house");
    expect(agentDirectionOf({ origin: "cli" })).toBe("external");
  });
  it("an unknown direction value is ignored, never trusted", () => {
    expect(agentDirectionOf({ direction: "weird", origin: "system" })).toBe(
      "house"
    );
  });
});
