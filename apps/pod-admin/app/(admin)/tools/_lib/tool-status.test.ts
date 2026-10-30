import { describe, expect, it } from "vitest";
import {
  capabilityStatus,
  skillStatus,
  statusRank,
  type CapabilityCardStatus,
  type RunHealth,
} from "./tool-status";

const OK: RunHealth = { status: "ok", failedRuns: 0, stuckRuns: 0 };
const FAILED: RunHealth = { status: "failed", failedRuns: 2, stuckRuns: 0 };
const STUCK: RunHealth = { status: "degraded", failedRuns: 0, stuckRuns: 1 };
const NONE: RunHealth = { status: "unknown", failedRuns: 0, stuckRuns: 0 };

const card = (status: CapabilityCardStatus, verbs = 2) => ({
  status,
  verbs: Array.from({ length: verbs }, (_, i) => ({ i })),
});

describe("capabilityStatus — the ONE mark, list and page", () => {
  it("reads every card state as a labelled mark", () => {
    const all: CapabilityCardStatus[] = [
      "available",
      "needs_connection",
      "connected",
      "draft",
      "ready",
      "partial",
      "unavailable",
    ];
    for (const s of all) {
      const mark = capabilityStatus({ card: card(s), health: OK });
      expect(mark.label, s).toBeTruthy();
    }
  });

  it("all actions on and runs fine is On", () => {
    expect(capabilityStatus({ card: card("ready"), health: OK })).toEqual({
      kind: "healthy",
      label: "On",
    });
    // No run yet is still On: being on is the card's fact, not the runs'.
    expect(capabilityStatus({ card: card("ready"), health: NONE })).toEqual({
      kind: "healthy",
      label: "On",
    });
  });

  it("actions off: the page's 'Actions off' and the list's verdict are one (wrong rule: healthy runs read Healthy)", () => {
    // The two old pills disagreed exactly here: the list said "Healthy" for a
    // draft whose runs were fine, the page said "Actions off".
    expect(capabilityStatus({ card: card("draft"), health: OK })).toEqual({
      kind: "stale",
      label: "Actions off",
    });
    expect(capabilityStatus({ card: card("partial"), health: OK })).toEqual({
      kind: "stale",
      label: "Some actions off",
    });
  });

  it("a container with no action is never 'Actions off' (nothing to turn on)", () => {
    expect(capabilityStatus({ card: card("draft", 0), health: OK })).toEqual({
      kind: "healthy",
      label: "On",
    });
  });

  it("worst first: no account, then failing, then actions off, then stuck", () => {
    expect(
      capabilityStatus({ card: card("needs_connection"), health: FAILED })
    ).toEqual({ kind: "down", label: "Needs an account" });
    expect(capabilityStatus({ card: card("partial"), health: FAILED })).toEqual(
      { kind: "down", label: "2 failed runs" }
    );
    expect(capabilityStatus({ card: card("partial"), health: STUCK })).toEqual({
      kind: "stale",
      label: "Some actions off",
    });
    expect(capabilityStatus({ card: card("ready"), health: STUCK })).toEqual({
      kind: "stale",
      label: "1 stuck run",
    });
  });

  it("an unread card is never On (wrong rule: missing card = fine)", () => {
    expect(capabilityStatus({ card: null, health: OK })).toEqual({
      kind: "unknown",
      label: "State unknown",
    });
    // …but what the runs say still shows.
    expect(capabilityStatus({ card: null, health: FAILED }).kind).toBe("down");
    expect(capabilityStatus({ card: null, health: null }).kind).toBe("unknown");
  });
});

describe("skillStatus", () => {
  it("on or off", () => {
    expect(skillStatus({ approved: true })).toEqual({
      kind: "healthy",
      label: "On",
    });
    expect(skillStatus({ approved: false })).toEqual({
      kind: "stale",
      label: "Off",
    });
  });
});

describe("statusRank", () => {
  it("down, then stale, then the rest", () => {
    expect(statusRank({ kind: "down", label: "" })).toBe(0);
    expect(statusRank({ kind: "stale", label: "" })).toBe(1);
    expect(statusRank({ kind: "healthy", label: "" })).toBe(2);
    expect(statusRank({ kind: "unknown", label: "" })).toBe(2);
  });
});
