/** A goal's workers: run marks, health, the goal rollup (goals that run). */
import { describe, expect, it } from "vitest";
import { resolveUnitState } from "../units/state.js";
import {
  RUN_HEALTH_STATES,
  consecutiveFailuresOf,
  deriveRunHealth,
  goalRunHealth,
  runHealthUnitInput,
  runMarkOfRunStatus,
  workerTriggerKind,
  type RunMark,
  type RunMarkEntry,
} from "./health.js";

const marks = (...ms: RunMark[]): RunMarkEntry[] =>
  ms.map((mark, i) => ({
    runId: `r${i}`,
    mark,
    at: new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
  }));

const live = {
  paused: false,
  automationStatus: "active",
  pendingApprovals: 0,
} as const;

describe("runMarkOfRunStatus", () => {
  it("maps every stored run status; a budget stop is skipped, not failed", () => {
    expect(runMarkOfRunStatus("completed")).toBe("done");
    expect(runMarkOfRunStatus("failed")).toBe("failed");
    expect(runMarkOfRunStatus("failed", "budget")).toBe("skipped");
    expect(runMarkOfRunStatus("waiting_on_you")).toBe("waiting");
    expect(runMarkOfRunStatus("blocked_by_policy")).toBe("skipped");
    expect(runMarkOfRunStatus("cancelled")).toBe("skipped");
    expect(runMarkOfRunStatus("running")).toBe("running");
    expect(runMarkOfRunStatus("nonsense")).toBeNull();
    expect(runMarkOfRunStatus(null)).toBeNull();
  });
});

describe("consecutiveFailuresOf — the breaker's streak", () => {
  it("counts failures since the last success; skipped neither breaks nor heals", () => {
    expect(consecutiveFailuresOf(marks("failed", "done", "failed"))).toBe(1);
    expect(
      consecutiveFailuresOf(marks("done", "failed", "skipped", "failed"))
    ).toBe(2);
    expect(consecutiveFailuresOf(marks("failed", "failed", "done"))).toBe(0);
    expect(consecutiveFailuresOf([])).toBe(0);
  });
});

describe("deriveRunHealth — ONE state", () => {
  it("a person's pause outranks everything", () => {
    expect(
      deriveRunHealth({
        ...live,
        paused: true,
        automationStatus: "error",
        marks: marks("failed"),
      }).state
    ).toBe("paused");
  });

  it("the breaker's stop reads off, with its sentence", () => {
    const h = deriveRunHealth({
      ...live,
      automationStatus: "error",
      automationError: "Turned off automatically after 3 failed runs in a row.",
      marks: marks("failed", "failed", "failed"),
    });
    expect(h.state).toBe("off");
    expect(h.offReason).toMatch(/Turned off/);
    expect(h.consecutiveFailures).toBe(3);
  });

  it("a last failure is failing, even with approvals waiting", () => {
    expect(
      deriveRunHealth({
        ...live,
        pendingApprovals: 2,
        marks: marks("done", "failed"),
      }).state
    ).toBe("failing");
  });

  it("approvals or a waiting last run read waiting; otherwise healthy (no runs yet too)", () => {
    expect(
      deriveRunHealth({ ...live, pendingApprovals: 1, marks: [] }).state
    ).toBe("waiting");
    expect(deriveRunHealth({ ...live, marks: marks("waiting") }).state).toBe(
      "waiting"
    );
    expect(deriveRunHealth({ ...live, marks: [] }).state).toBe("healthy");
  });

  it("on but with no live automation is not running", () => {
    expect(
      deriveRunHealth({ ...live, automationStatus: null, marks: [] }).state
    ).toBe("not_running");
  });

  it("keeps the newest 10 marks, oldest first", () => {
    const h = deriveRunHealth({
      ...live,
      marks: marks(...Array<RunMark>(12).fill("done")),
    });
    expect(h.marks).toHaveLength(10);
    expect(h.marks[0]!.runId).toBe("r2");
    expect(h.marks[9]!.runId).toBe("r11");
  });
});

describe("goalRunHealth — the goal reads its worst worker", () => {
  const w = (state: (typeof RUN_HEALTH_STATES)[number]) => ({
    health: { state },
  });
  it("failure outranks your turn outranks calm; all paused is paused; none is not running", () => {
    expect(goalRunHealth([w("healthy"), w("waiting"), w("failing")])).toBe(
      "failing"
    );
    expect(goalRunHealth([w("healthy"), w("waiting")])).toBe("waiting");
    expect(goalRunHealth([w("healthy"), w("paused")])).toBe("healthy");
    expect(goalRunHealth([w("paused"), w("paused")])).toBe("paused");
    expect(goalRunHealth([])).toBe("not_running");
  });
});

describe("runHealthUnitInput — tone and glyph come from the unit-state door", () => {
  it("every health state has a unit state", () => {
    const got = Object.fromEntries(
      RUN_HEALTH_STATES.map((s) => [
        s,
        resolveUnitState(runHealthUnitInput(s)).state,
      ])
    );
    expect(got).toEqual({
      failing: "failed",
      off: "failed",
      waiting: "needs_review",
      healthy: "scheduled",
      paused: "paused",
      not_running: "not_started",
    });
  });
});

describe("workerTriggerKind", () => {
  it("a clock, something happening, or a button", () => {
    expect(workerTriggerKind("schedule")).toBe("schedule");
    expect(workerTriggerKind("created")).toBe("event");
    expect(workerTriggerKind("enters_status")).toBe("event");
    expect(workerTriggerKind("count")).toBe("event");
    expect(workerTriggerKind("manual")).toBe("manual");
    expect(workerTriggerKind(null)).toBe("manual");
  });
});
