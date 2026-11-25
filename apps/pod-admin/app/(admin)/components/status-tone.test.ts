import { describe, expect, it } from "vitest";
import { UNIT_TONES, resolveUnitState } from "@synap-core/types/units";
import {
  PROCESS_ATTENTION_STATES,
  PROCESS_HEALTH_STATES,
  processHealthUnitInput,
} from "@synap-core/types/processes";
import { unitTonePill } from "./status-tone";

/**
 * The one unit-tone → pill map. "Your turn" (waiting on you, a check gate,
 * blocked by policy) once drew as the green healthy pill on goals, and would
 * have on processes: these pin that it never does again, from the real unit
 * state the desktop draws, not from a hand-picked tone.
 */
describe("unitTonePill", () => {
  it("maps every unit tone", () => {
    expect(UNIT_TONES.length).toBeGreaterThan(5); // non-vacuity
    for (const tone of UNIT_TONES) {
      expect(["healthy", "stale", "down", "unknown"]).toContain(
        unitTonePill(tone)
      );
    }
  });

  it("never draws waiting on you, or a check gate, as healthy", () => {
    for (const input of [{ waitingOnYou: true }, { checkGate: true }]) {
      expect(unitTonePill(resolveUnitState(input).tone)).toBe("stale");
    }
  });

  it("never draws a process state that needs a person as healthy", () => {
    expect(PROCESS_ATTENTION_STATES.length).toBeGreaterThan(2); // non-vacuity
    for (const state of PROCESS_ATTENTION_STATES) {
      const kind = unitTonePill(
        resolveUnitState(processHealthUnitInput({ state })).tone
      );
      expect(kind, state).not.toBe("healthy");
    }
  });

  it("draws only a running process as the healthy pill", () => {
    const healthy = PROCESS_HEALTH_STATES.filter(
      (state) =>
        unitTonePill(
          resolveUnitState(processHealthUnitInput({ state })).tone
        ) === "healthy"
    );
    expect(healthy).toEqual(["running"]);
  });
});
