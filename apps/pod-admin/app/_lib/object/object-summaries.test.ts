import { describe, expect, it } from "vitest";
import {
  automationSummary,
  runLine,
  sessionCanCancel,
  sessionCanRevert,
  sessionSummary,
  shortDescription,
} from "./object-summaries";

describe("shortDescription / runLine", () => {
  it("folds a description to one bounded line, or nothing", () => {
    expect(shortDescription("  two\n lines ")).toBe("two lines");
    expect(shortDescription("   ")).toBeNull();
    expect(shortDescription(42)).toBeNull();
  });

  it("leads a failed run with its error", () => {
    expect(
      runLine({ status: "failed", startedAt: null, errorMessage: "Boom\nx" })
    ).toEqual({ primary: "Started at an unknown time", secondary: "Boom x" });
  });
});

describe("automationSummary", () => {
  const base = {
    status: "active",
    triggerType: "event",
    runCount: 0,
    failureCount: 0,
  };
  it("leads with what is wrong", () => {
    expect(
      automationSummary({ ...base, status: "error", errorMessage: "Bad cron" })
    ).toBe("Stopped on an error: Bad cron");
    expect(automationSummary({ ...base, status: "paused" })).toContain(
      "Paused"
    );
  });

  it("says how it runs, and how often it failed", () => {
    expect(automationSummary(base)).toBe(
      "Runs when its trigger event happens."
    );
    expect(automationSummary({ ...base, runCount: 12, failureCount: 10 })).toBe(
      "Runs when its trigger event happens. 10 of 12 runs failed."
    );
    expect(
      automationSummary({ ...base, triggerType: "cron", nextRunAt: null })
    ).toBe("Runs on a schedule.");
  });
});

describe("session actions and summary", () => {
  it("cancels only work in flight; reverts only what landed", () => {
    expect(sessionCanCancel("active")).toBe(true);
    expect(sessionCanCancel("closed")).toBe(false);
    expect(sessionCanRevert("closed")).toBe(true);
    expect(sessionCanRevert("active")).toBe(false);
    expect(sessionCanCancel("stale")).toBe(true);
    expect(sessionCanCancel("scheduled")).toBe(true);
    expect(sessionCanRevert("failed")).toBe(true);
    expect(sessionCanRevert("stale")).toBe(false);
  });

  it("reads liveness without folding a failed read into 'never'", () => {
    expect(
      sessionSummary({
        status: "active",
        liveness: { status: "unavailable", reason: "x" },
      })
    ).toBe("In progress.");
    expect(
      sessionSummary({
        status: "active",
        liveness: { status: "ok", lastAgentActivityAt: null },
      })
    ).toBe("In progress — no agent has acted on it yet.");
    expect(sessionSummary({ status: "closed", closedAt: null })).toBe(
      "Closed."
    );
  });
});
