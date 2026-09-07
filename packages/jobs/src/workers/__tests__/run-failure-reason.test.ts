/**
 * A FAILED RUN MUST SAY WHY.
 *
 * The incident: automation `New Contact Enrichment` ran 541 times with 0
 * successes; 270 of its 271 failed runs stored `error_message = NULL`. The
 * reason was known all along — `describeLedgerError(lastError)` wrote it onto
 * the STEP row — but the run row's ordinary terminal close omitted the column,
 * so every failure surface (`runLedgerDetail` → `AutomationLastFailure`) fell
 * back to the boilerplate "This run failed."
 *
 * The 1 non-NULL row came from the defensive finalizer, which only runs when
 * the flow THROWS. This file pins the ORDINARY, non-throwing path — the one 270
 * failures actually took.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRunTerminalUpdate } from "../automation-executor.js";
import {
  shouldTripNeverWorkedBreaker,
  breakerErrorMessage,
  NEVER_WORKED_FAILURE_LIMIT,
} from "../automation-breaker.js";

const theIncidentReason =
  "IS command call failed [IS error] — HTTP 404 Not Found after 9ms of a 120000ms budget";

describe("run terminal close — a failure carries its reason", () => {
  it("persists the first failed step's message on an ORDINARY (non-throwing) failure", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "failed",
      stepsCompleted: 0,
      stepsFailed: 1,
      firstFailureMessage: theIncidentReason,
      outputSummary: null,
    });

    expect(update.status).toBe("failed");
    expect(update.errorMessage).toBe(theIncidentReason);
    // The exact assertion the 270 NULL rows would have failed.
    expect(update.errorMessage ?? null).not.toBeNull();
  });

  it("carries the reason on a policy-block too (calm outcome, still a cause)", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "blocked_by_policy",
      stepsCompleted: 1,
      stepsFailed: 1,
      firstFailureMessage: "command cannot auto-execute: …",
      outputSummary: null,
    });
    expect(update.errorMessage).toBe("command cannot auto-execute: …");
  });

  it("reports the FIRST cause, not a step-count roll-up (the counts are their own columns)", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "failed",
      stepsCompleted: 2,
      stepsFailed: 2,
      firstFailureMessage: theIncidentReason,
      outputSummary: null,
    });
    expect(update.errorMessage).toBe(theIncidentReason);
    expect(update.errorMessage).not.toMatch(/\bof\s+\d+\s+steps?\b/i);
    // …and the counts the roll-up would have restated are still written.
    expect(update.stepsFailed).toBe(2);
    expect(update.stepsCompleted).toBe(2);
  });

  it("writes NO errorMessage on a completed run", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "completed",
      stepsCompleted: 3,
      stepsFailed: 0,
      firstFailureMessage: null,
      outputSummary: { lastStepOutput: { ok: true } },
    });
    expect("errorMessage" in update).toBe(false);
    expect(update.outputSummary).toEqual({ lastStepOutput: { ok: true } });
  });

  it("omits the column rather than storing an empty string when no reason was captured", () => {
    const update = buildRunTerminalUpdate({
      finalStatus: "failed",
      stepsCompleted: 0,
      stepsFailed: 1,
      firstFailureMessage: null,
      outputSummary: null,
    });
    expect("errorMessage" in update).toBe(false);
  });

  /**
   * The builder being right is worthless if the executor stopped calling it —
   * that is the seam the extraction created, so it is pinned here.
   */
  it("is the projection the executor's terminal write actually uses", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../automation-executor.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toMatch(
      /\.update\(automationRuns\)\s*\n\s*\.set\(\s*\n?\s*buildRunTerminalUpdate\(/
    );
  });
});

describe("never-worked breaker", () => {
  const active = (successCount: number, failureCount: number) => ({
    status: "active",
    successCount,
    failureCount,
  });

  it("does NOT trip below the limit", () => {
    expect(
      shouldTripNeverWorkedBreaker(active(0, NEVER_WORKED_FAILURE_LIMIT - 1))
    ).toBe(false);
  });

  it("trips at the limit with zero successes", () => {
    expect(
      shouldTripNeverWorkedBreaker(active(0, NEVER_WORKED_FAILURE_LIMIT))
    ).toBe(true);
    // The incident's automation: 541 runs, 0 successes.
    expect(shouldTripNeverWorkedBreaker(active(0, 541))).toBe(true);
  });

  it("NEVER trips on an automation that has ever succeeded", () => {
    expect(shouldTripNeverWorkedBreaker(active(1, 5_000))).toBe(false);
  });

  it("only trips an ACTIVE automation (a paused/errored row is already off)", () => {
    for (const status of ["draft", "paused", "error", "archived"]) {
      expect(
        shouldTripNeverWorkedBreaker({
          status,
          successCount: 0,
          failureCount: 999,
        })
      ).toBe(false);
    }
  });

  it("explains itself in a sentence that names the cause AND the way back", () => {
    const msg = breakerErrorMessage(10, theIncidentReason);
    expect(msg).toContain("10 failed runs");
    expect(msg).toContain("HTTP 404 Not Found");
    expect(msg).toMatch(/set this automation back to Active/i);
  });

  it("still explains itself when no step reason was captured", () => {
    const msg = breakerErrorMessage(10, null);
    expect(msg).toContain("10 failed runs");
    expect(msg).not.toContain("Last failure:");
  });
});
