/**
 * Happening's rule population: ONE row per rule, never one per run — 300
 * Gmail-triggered runs of one rule are one "×300" row grouped under the rule;
 * a failure inside the window is counted on that row.
 */
import { describe, it, expect } from "vitest";
import { foldRuleRuns, ruleRunGroupKey, type RuleRunRow } from "./rule-runs.js";

const now = new Date("2026-10-05T12:00:00Z");
const at = (s: number) => new Date(now.getTime() - s * 1000);

describe("foldRuleRuns", () => {
  it("folds 300 runs of one rule into ONE row with the run count", () => {
    const rows: RuleRunRow[] = Array.from({ length: 300 }, (_, i) => ({
      automationId: "a1",
      automationName: "New contact enrichment",
      status: "completed",
      startedAt: at(i),
    }));
    const out = foldRuleRuns(rows, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "rule-run",
      count: 300,
      repeatCount: 300,
      target: { kind: "automation", id: "a1" },
      groupKey: ruleRunGroupKey("a1"),
      ruleRun: { runs: 300, failed: 0, running: false },
    });
    expect(out[0]!.occurredAt).toEqual(at(0));
  });

  it("keeps two rules apart, newest first, and counts failures and in-flight runs", () => {
    const out = foldRuleRuns(
      [
        {
          automationId: "a1",
          automationName: "A",
          status: "failed",
          startedAt: at(200),
        },
        {
          automationId: "a2",
          automationName: "B",
          status: "running",
          startedAt: at(5),
        },
        {
          automationId: "a1",
          automationName: "A",
          status: "completed",
          startedAt: at(100),
        },
      ],
      now
    );
    expect(out.map((s) => s.target?.id)).toEqual(["a2", "a1"]);
    expect(out[1]!.ruleRun).toEqual({
      automationId: "a1",
      runs: 2,
      failed: 1,
      running: false,
      latestStatus: "completed",
    });
    expect(out[0]!.ruleRun?.running).toBe(true);
  });

  it("in flight is the run-status door's answer (pending/queued too), not a literal", () => {
    const out = foldRuleRuns(
      [
        {
          automationId: "a1",
          automationName: "A",
          status: "pending",
          startedAt: at(5),
        },
        {
          automationId: "a2",
          automationName: "B",
          status: "completed",
          startedAt: at(5),
        },
      ],
      now
    );
    const byId = new Map(out.map((s) => [s.target?.id, s.ruleRun]));
    expect(byId.get("a1")).toMatchObject({
      running: true,
      latestStatus: "pending",
    });
    expect(byId.get("a2")).toMatchObject({
      running: false,
      latestStatus: "completed",
    });
  });

  it("an empty window is no rows", () => {
    expect(foldRuleRuns([], now)).toEqual([]);
  });
});
