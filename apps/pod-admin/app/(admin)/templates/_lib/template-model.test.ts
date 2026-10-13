import { describe, expect, it } from "vitest";
import {
  errorLine,
  executorLabel,
  failureExplanation,
  groupFactsFromRuns,
  runsThisWeek,
  stageNames,
  templateHealthPill,
  templateSummary,
  type TemplateGroupFacts,
} from "./template-model";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function group(over: Partial<TemplateGroupFacts> = {}): TemplateGroupFacts {
  return {
    runCount: 12,
    recentFailedCount: 0,
    runningCount: 0,
    latestStatus: "completed",
    ...over,
  };
}

describe("templateHealthPill", () => {
  it("puts the template's own status first", () => {
    expect(
      templateHealthPill("draft", group({ recentFailedCount: 3 }))
    ).toEqual({ kind: "unknown", label: "Draft" });
    expect(templateHealthPill("paused", group()).label).toBe("Paused");
  });
  it("reads health from this week", () => {
    expect(templateHealthPill("active", undefined).label).toBe("Never ran");
    expect(
      templateHealthPill("active", group({ recentFailedCount: 10 }))
    ).toEqual({ kind: "down", label: "Failing" });
    expect(templateHealthPill("active", group({ runningCount: 1 })).label).toBe(
      "Running"
    );
    expect(
      templateHealthPill("active", group({ latestStatus: "failed" }))
    ).toEqual({ kind: "stale", label: "Failed last run" });
    expect(templateHealthPill("active", group()).label).toBe("Working");
  });
});

describe("templateSummary", () => {
  it("prefers the description's first sentence", () => {
    expect(
      templateSummary("Runs a dev task. Then reports.", "Build {feature}")
    ).toBe("Runs a dev task.");
  });
  it("reads goal references as names", () => {
    expect(
      templateSummary(null, "Research @{arg:company} for {owner}.\nMore.")
    ).toBe("Research ‹company› for ‹owner›.");
  });
  it("is null with nothing to say and bounded when long", () => {
    expect(templateSummary("  ", null)).toBeNull();
    expect(templateSummary("x".repeat(300), null)!.length).toBe(201);
  });
});

describe("executorLabel", () => {
  it("names who carries the run", () => {
    expect(executorLabel("is-agent")).toBe("Synap’s agent");
    expect(executorLabel("external-agent")).toBe("A connected agent");
    expect(executorLabel(undefined)).toBe("—");
  });
});

describe("runsThisWeek", () => {
  const run = (id: string, hoursAgo: number, status = "completed") => ({
    id,
    status,
    startedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
  });
  it("counts runs and failures inside the week", () => {
    const runs = [run("a", 1, "failed"), run("b", 30), run("c", 24 * 8)];
    expect(runsThisWeek(runs, NOW, 100)).toEqual({
      total: 2,
      failed: 1,
      atLeast: false,
    });
  });
  it("says at least when the read limit, not the week, ended the count", () => {
    expect(runsThisWeek([run("a", 1), run("b", 2)], NOW, 2).atLeast).toBe(true);
  });
});

describe("groupFactsFromRuns / stageNames", () => {
  it("derives health from the template's own runs", () => {
    const runs = [
      { id: "a", status: "running", startedAt: NOW },
      {
        id: "b",
        status: "failed",
        startedAt: new Date(NOW.getTime() - HOUR),
      },
      {
        id: "c",
        status: "failed",
        startedAt: new Date(NOW.getTime() - 24 * 9 * HOUR),
      },
    ];
    expect(groupFactsFromRuns(runs, NOW)).toEqual({
      runCount: 3,
      recentFailedCount: 1,
      runningCount: 1,
      latestStatus: "running",
    });
    expect(groupFactsFromRuns([], NOW)).toBeUndefined();
  });
  it("reads stage names, falling back to keys", () => {
    expect(
      stageNames([{ key: "plan", name: "Plan" }, { key: "build" }, null, 3])
    ).toEqual(["Plan", "build"]);
    expect(stageNames(undefined)).toEqual([]);
  });
});

describe("failureExplanation", () => {
  const failed = (id: string, error: string | null) => ({
    id,
    status: "failed",
    startedAt: NOW,
    error,
  });
  const ok = { id: "ok", status: "completed", startedAt: NOW };

  it("is null when nothing failed", () => {
    expect(failureExplanation([ok])).toBeNull();
  });
  it("names the shared error", () => {
    const out = failureExplanation([
      failed("r12", "Executor session expired after 30 min"),
      failed("r11", "Executor session  expired after 30 min"),
      ok,
    ]);
    expect(out).toEqual({
      sentence:
        "2 of the last 3 runs failed. 2 of them stopped with the same error: “Executor session expired after 30 min”",
      latestFailedRunId: "r12",
    });
  });
  it("falls back to the latest error, or says none was recorded", () => {
    expect(failureExplanation([failed("r1", "boom"), ok])!.sentence).toBe(
      "1 of the last 2 runs failed. The latest stopped with: “boom”"
    );
    expect(failureExplanation([failed("r1", null)])!.sentence).toMatch(
      /without recording why/
    );
  });
  it("keeps an error to one line", () => {
    expect(errorLine("a\n b")).toBe("a b");
    expect(errorLine("")).toBeNull();
  });
});
