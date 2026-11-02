/**
 * THE runner order (sessions cockpit C4): every word a runner may say maps to
 * ONE wait kind, in ONE urgency order that the fold, the holder and the
 * needs-you rule all read.
 *
 * The map is typed `satisfies Record<LiveRunnerState, WaitKind>`, so a word
 * added to `RUNNER_STATES` with no row stops the build; this pins the same
 * at run time (a test gate runs without the type checker) and pins the
 * order itself, which is a decision, not a refactor.
 */
import { describe, it, expect } from "vitest";
import {
  RUNNER_STATES,
  RUNNER_STATE_ORDER,
  RUNNER_STATE_WAIT_KIND,
  isRunnerState,
  runnerStateRank,
  runnerStateWaitKind,
} from "./runner-state.js";
import { WAIT_KIND_BALL } from "./wait-kind.js";

describe("the runner order", () => {
  it("gives EVERY live word a wait kind, and no word that does not exist", () => {
    const live = RUNNER_STATES.filter((s) => s !== "ended");
    expect([...RUNNER_STATE_ORDER].sort()).toEqual([...live].sort());
    expect(Object.keys(RUNNER_STATE_WAIT_KIND).sort()).toEqual(
      [...live].sort()
    );
  });

  it("ranks the person's terminal waits first: permission, then answer, then work, then rest", () => {
    expect(RUNNER_STATE_ORDER).toEqual([
      "needs_permission",
      "needs_answer",
      "busy",
      "idle",
    ]);
    expect(RUNNER_STATE_WAIT_KIND).toEqual({
      needs_permission: "approval",
      needs_answer: "answer",
      busy: "agent_work",
      idle: "agent_stopped",
    });
    // Both terminal waits are the person's move; the others the agent's.
    expect(
      RUNNER_STATE_ORDER.map((s) => WAIT_KIND_BALL[RUNNER_STATE_WAIT_KIND[s]])
    ).toEqual(["me", "me", "agent", "agent"]);
  });

  it("an ended, absent or unknown word has no wait kind and ranks last", () => {
    for (const w of ["ended", null, undefined, "asleep", "toString"]) {
      expect(runnerStateWaitKind(w)).toBeNull();
      expect(runnerStateRank(w)).toBe(RUNNER_STATE_ORDER.length);
    }
    expect(runnerStateRank("needs_answer")).toBe(1);
    expect(isRunnerState("ended")).toBe(true);
    expect(isRunnerState("asleep")).toBe(false);
  });
});
