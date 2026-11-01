import { describe, expect, it } from "vitest";
import type { RunHealth } from "@synap-core/types/workers/health";
import {
  RUN_HEALTH_LEGEND,
  runHealthCell,
  servesGoalCell,
  servesGoalText,
} from "./run-health-view";

const health = (over: Partial<RunHealth> = {}): RunHealth => ({
  state: "healthy",
  marks: [],
  consecutiveFailures: 0,
  offReason: null,
  ...over,
});

describe("servesGoalCell", () => {
  it("says None when no goal is served", () => {
    expect(servesGoalCell(null)).toEqual({ kind: "none", label: "None" });
    expect(servesGoalCell([])).toEqual({ kind: "none", label: "None" });
    expect(servesGoalText(servesGoalCell(undefined))).toBe("Serves no goal");
  });
  it("names the goal, and counts the others of a template", () => {
    expect(servesGoalCell({ id: "g1", name: "Launch" })).toEqual({
      kind: "goals",
      first: { id: "g1", name: "Launch" },
      more: 0,
    });
    const many = servesGoalCell([
      { id: "g1", name: "Launch" },
      { id: "g2", name: "Hire" },
      { id: "g3", name: "Raise" },
    ]);
    expect(many).toMatchObject({ kind: "goals", more: 2 });
    expect(servesGoalText(many)).toBe("Serves Launch +2");
  });
});

describe("runHealthCell", () => {
  it("reads healthy as healthy, with its strip", () => {
    const c = runHealthCell(
      health({
        marks: [{ runId: "r1", mark: "done", at: "2026-11-01T10:00:00Z" }],
      })
    );
    expect(c).toMatchObject({ kind: "healthy", label: "Healthy" });
    expect(c.strip).toHaveLength(1);
    expect(c.strip[0]!.title).toContain("Done");
  });
  it("reads failing as down and counts the streak", () => {
    const c = runHealthCell(
      health({ state: "failing", consecutiveFailures: 3 })
    );
    expect(c.kind).toBe("down");
    expect(c.sentence).toBe("Failing · 3 failures in a row");
  });
  it("gives the breaker's sentence when the pod turned it off", () => {
    const c = runHealthCell(
      health({ state: "off", offReason: "Stopped after 3 failures" })
    );
    expect(c).toMatchObject({ kind: "down", label: "Turned off" });
    expect(c.sentence).toContain("Stopped after 3 failures");
  });
  it("never guesses healthy when the pod gave no health", () => {
    expect(runHealthCell(null)).toMatchObject({
      kind: "unknown",
      label: "No health yet",
      strip: [],
    });
  });
  it("legend covers every state once", () => {
    expect(RUN_HEALTH_LEGEND.map((l) => l.state).sort()).toEqual(
      ["failing", "healthy", "not_running", "off", "paused", "waiting"].sort()
    );
  });
});
