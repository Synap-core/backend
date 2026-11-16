/**
 * The two presentation helpers every process surface reads (Process wave plan
 * 0adf8352 W4): the health's ONE tone (`processHealthUnitInput`) and who moves
 * a step on (`classifyStepRunner`). The sets are DERIVED from the leaf's own
 * value lists, so a new health state or runner kind joins the scan by existing.
 */
import { describe, expect, it } from "vitest";
import { resolveUnitState, type UnitState } from "../units/state.js";
import {
  PROCESS_ATTENTION_STATES,
  PROCESS_HEALTH_STATES,
  processHealthUnitInput,
} from "./health.js";
import { PROCESS_STEP_RUNNER_KINDS, classifyStepRunner } from "./steps.js";

const markOf = (state: (typeof PROCESS_HEALTH_STATES)[number]): UnitState =>
  resolveUnitState(processHealthUnitInput({ state })).state;

describe("processHealthUnitInput — the one tone of a process health", () => {
  it("maps every health state (derived from PROCESS_HEALTH_STATES)", () => {
    expect(PROCESS_HEALTH_STATES.length).toBeGreaterThanOrEqual(10);
    for (const state of PROCESS_HEALTH_STATES) {
      expect(processHealthUnitInput({ state }), state).toBeTypeOf("object");
    }
  });

  it("a failure is the failed mark; nothing else is", () => {
    const failed = PROCESS_HEALTH_STATES.filter((s) => markOf(s) === "failed");
    expect(failed.sort()).toEqual(["config-error", "unresolved-failure"]);
  });

  it("every state that needs the person reads as their turn or a failure, never calm", () => {
    for (const state of PROCESS_ATTENTION_STATES) {
      expect(["failed", "needs_you"], state).toContain(markOf(state));
    }
    // Policy said no: a person's eye, calm — not the red of a failure.
    expect(markOf("blocked-by-policy")).toBe("needs_you");
    expect(markOf("waiting-on-you")).toBe("needs_you");
  });

  it("the rest: running works, healthy is done, paused rests, not started yet, unmeasured", () => {
    expect(markOf("running")).toBe("working");
    expect(markOf("healthy")).toBe("done");
    expect(markOf("paused")).toBe("paused");
    expect(markOf("draft")).toBe("not_started");
    expect(markOf("never-run")).toBe("not_started");
    // Unmeasured is never drawn as calm (the rows' first defect class).
    expect(markOf("unknown")).toBe("unmeasured");
  });
});

describe("classifyStepRunner — who moves a step on", () => {
  it("a human gate waits on a person; a check gate clears automatically", () => {
    expect(classifyStepRunner({ gate: "human" })).toBe("person");
    expect(classifyStepRunner({ gate: { kind: "human" } })).toBe("person");
    expect(classifyStepRunner({ gate: "check" })).toBe("automatic");
    expect(classifyStepRunner({ gate: { kind: "check" } })).toBe("automatic");
  });

  it("the gate decides before the runner (a gated agent step is the gate's)", () => {
    expect(classifyStepRunner({ gate: "human", runner: "synap_ai" })).toBe(
      "person"
    );
    expect(
      classifyStepRunner({ gate: "check", runner: { agentId: "a-1" } })
    ).toBe("automatic");
  });

  it("every runner shape is an agent; no runner is the run's own agent", () => {
    const runners: unknown[] = [
      null,
      undefined,
      "self",
      "synap_ai",
      { synapAi: { persona: "writer" } },
      { agentId: "a-1", preset: "fast" },
      { role: "reviewer" },
      { engine: "claude-code", computer: "devbox" },
      ["self", { engine: "claude-code" }],
      { somethingNew: true },
    ];
    for (const runner of runners) {
      expect(classifyStepRunner({ runner }), JSON.stringify(runner)).toBe("ai");
    }
    // An `awaits` gate or an unknown gate falls through to the runner.
    expect(classifyStepRunner({ gate: "awaits" })).toBe("ai");
    expect(classifyStepRunner({ gate: { kind: 42 } })).toBe("ai");
  });

  it("only ever answers one of its declared kinds", () => {
    for (const step of [
      {},
      { gate: "human" },
      { gate: "check" },
      { runner: "self" },
    ]) {
      expect(PROCESS_STEP_RUNNER_KINDS).toContain(classifyStepRunner(step));
    }
  });
});
