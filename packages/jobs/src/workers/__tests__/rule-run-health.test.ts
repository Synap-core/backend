/**
 * Two rule-health verdicts the Rules page reads off the run ledger:
 *
 *  1. A rule that WORKED and then broke turns itself off (the never-worked
 *     breaker's documented gap). The streak counts settled runs only —
 *     a skip or a policy block neither breaks nor heals it.
 *  2. A run whose last act was a dedup skip (a propose-mode THEN that found its
 *     pending proposal) reads `skipped` with the reason token, the way a
 *     daily-cap skip already does — never a `completed` that claims work.
 */
import { describe, it, expect } from "vitest";
import { AUTOMATION_SKIP_REASONS } from "@synap-core/types/automations";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  brokeAfterWorkingMessage,
  shouldTripBrokeAfterWorking,
} from "../automation-breaker.js";
import {
  buildRunTerminalUpdate,
  runSkipReasonOf,
} from "../automation-executor.js";

const failed = (n: number) => Array.from({ length: n }, () => "failed");

describe("worked-then-broke breaker", () => {
  it(`trips an active rule with a success on record after ${CONSECUTIVE_FAILURE_LIMIT} failures in a row`, () => {
    expect(
      shouldTripBrokeAfterWorking({
        status: "active",
        successCount: 37,
        recentSettled: failed(CONSECUTIVE_FAILURE_LIMIT),
      })
    ).toBe(true);
  });

  it("does not trip while one success sits inside the window", () => {
    const window = failed(CONSECUTIVE_FAILURE_LIMIT);
    window[CONSECUTIVE_FAILURE_LIMIT - 1] = "completed";
    expect(
      shouldTripBrokeAfterWorking({
        status: "active",
        successCount: 37,
        recentSettled: window,
      })
    ).toBe(false);
  });

  it("does not trip on fewer settled runs than the limit (not enough evidence)", () => {
    expect(
      shouldTripBrokeAfterWorking({
        status: "active",
        successCount: 1,
        recentSettled: failed(CONSECUTIVE_FAILURE_LIMIT - 1),
      })
    ).toBe(false);
  });

  it("leaves a never-worked rule to the never-worked breaker", () => {
    expect(
      shouldTripBrokeAfterWorking({
        status: "active",
        successCount: 0,
        recentSettled: failed(CONSECUTIVE_FAILURE_LIMIT),
      })
    ).toBe(false);
  });

  it("never re-trips a rule a person already paused or the breaker already flagged", () => {
    for (const status of ["paused", "error", "draft", "archived"]) {
      expect(
        shouldTripBrokeAfterWorking({
          status,
          successCount: 5,
          recentSettled: failed(CONSECUTIVE_FAILURE_LIMIT),
        })
      ).toBe(false);
    }
  });

  it("tells the owner it had worked, and why it stopped", () => {
    const msg = brokeAfterWorkingMessage("HTTP 500 from Gmail");
    expect(msg).toContain(`${CONSECUTIVE_FAILURE_LIMIT} failed runs in a row`);
    expect(msg).toContain("HTTP 500 from Gmail");
    expect(msg).toMatch(/back to Active/);
  });
});

describe("a dedup skip is a skipped run", () => {
  const dedup = {
    lastStepOutput: {
      status: "skipped",
      reason: AUTOMATION_SKIP_REASONS.alreadyProposed,
      proposalId: "p1",
    },
    stepsCompleted: 2,
    status: "completed",
  };

  it("reads the reason token off the run's last output", () => {
    expect(runSkipReasonOf(dedup)).toBe("already_proposed");
  });

  it("writes `skipped` + the token on the run row (the cap's shape)", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "skipped",
      stepsCompleted: 2,
      stepsFailed: 0,
      firstFailureMessage: runSkipReasonOf(dedup),
      outputSummary: dedup,
    });
    expect(update.status).toBe("skipped");
    expect(update.errorMessage).toBe("already_proposed");
  });

  it("does not turn a run into a skip on an unknown reason or a proposal that was filed", () => {
    expect(
      runSkipReasonOf({ lastStepOutput: { status: "skipped", reason: "x" } })
    ).toBeNull();
    expect(
      runSkipReasonOf({
        lastStepOutput: { status: "proposed", proposalId: "p" },
      })
    ).toBeNull();
    expect(runSkipReasonOf(null)).toBeNull();
    expect(runSkipReasonOf({ lastStepOutput: "a scalar" })).toBeNull();
  });
});
