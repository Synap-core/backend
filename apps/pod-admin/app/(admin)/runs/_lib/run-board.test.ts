import { describe, expect, it } from "vitest";
import {
  flowHealthPill,
  flowHealthSentence,
  flowIsFailing,
  flowNoun,
  runActions,
  runRowSecondary,
  triggeredByLabel,
  type FlowGroupFacts,
} from "./run-board";

const NOW = new Date("2026-10-13T12:00:00.000Z");

function group(over: Partial<FlowGroupFacts> = {}): FlowGroupFacts {
  return {
    flowType: "automation",
    runCount: 12,
    recentFailedCount: 0,
    runningCount: 0,
    latestStatus: "completed",
    latestStartedAt: NOW,
    ...over,
  };
}

describe("flow words", () => {
  it("names registry kinds through the vocabulary, the rest plainly", () => {
    expect(flowNoun("automation")).toBe("Automation");
    expect(flowNoun("playbook")).toBe("Process");
    expect(flowNoun("chat")).toBe("AI turn");
    expect(flowNoun("agent_write")).toBe("Agent write");
  });

  it("says health from this week's failures, not the lifetime count", () => {
    expect(flowHealthSentence(group({ recentFailedCount: 10 }))).toBe(
      "10 failed this week · 12 runs in all"
    );
    expect(flowHealthSentence(group({ runningCount: 1, runCount: 1 }))).toBe(
      "1 running now · No failures this week · 1 run in all"
    );
    expect(flowHealthSentence(group({ latestStatus: "failed" }))).toBe(
      "Last run failed · 12 runs in all"
    );
    expect(flowIsFailing(group({ recentFailedCount: 1 }))).toBe(true);
    expect(flowIsFailing(group({ latestStatus: "failed" }))).toBe(false);
  });
});

describe("run rows", () => {
  it("leads with the error on one line", () => {
    const line = runRowSecondary({
      status: "failed",
      startedAt: null,
      error: "executor session\n expired after 30 min",
    });
    expect(line).toBe(
      "Started at an unknown time · executor session expired after 30 min"
    );
  });

  it("offers only the acts the pod's doors take", () => {
    expect(
      runActions({ flowType: "playbook", flowId: "p", status: "running" })
    ).toEqual({ cancel: true, runAgain: false });
    expect(
      runActions({ flowType: "playbook", flowId: "p", status: "failed" })
    ).toEqual({ cancel: false, runAgain: false });
    expect(
      runActions({ flowType: "automation", flowId: "a", status: "failed" })
    ).toEqual({ cancel: false, runAgain: true });
    expect(
      runActions({ flowType: "chat", flowId: null, status: "failed" })
    ).toEqual({ cancel: false, runAgain: false });
  });

  it("never shows an id as a name", () => {
    const id = "0b9c2a3e-1111-4222-8333-444455556666";
    expect(triggeredByLabel(id, id)).toBe("You");
    expect(triggeredByLabel(id, null)).toBe("A person or agent (0b9c2a…6666)");
    expect(triggeredByLabel("cron", null)).toBe("Cron");
    expect(triggeredByLabel(null, null)).toBeNull();
  });
});

describe("flowHealthPill", () => {
  it("puts the flow's own status first", () => {
    expect(flowHealthPill("draft", group({ latestStatus: "failed" }))).toEqual({
      kind: "unknown",
      label: "Draft",
    });
    expect(flowHealthPill("paused", group()).label).toBe("Paused");
    expect(flowHealthPill("error", undefined)).toEqual({
      kind: "down",
      label: "Stopped on error",
    });
  });
  it("reads the last run before the window's failures", () => {
    expect(flowHealthPill("active", undefined).label).toBe("Never ran");
    expect(
      flowHealthPill(
        "active",
        group({ latestStatus: "failed", recentFailedCount: 3 })
      )
    ).toEqual({ kind: "down", label: "Failed last run" });
    expect(flowHealthPill("active", group({ recentFailedCount: 2 }))).toEqual({
      kind: "stale",
      label: "2 failures",
    });
    expect(flowHealthPill(null, group({ runningCount: 1 }))).toEqual({
      kind: "healthy",
      label: "Running",
    });
    expect(flowHealthPill(null, group())).toEqual({
      kind: "healthy",
      label: "Working",
    });
  });
});
