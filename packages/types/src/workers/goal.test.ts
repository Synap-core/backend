/** A goal's runs rolled up from its workers (goals that run). */
import { describe, expect, it } from "vitest";
import { goalRunsRollup } from "./goal.js";
import type { RunHealthState, RunMarkEntry } from "./health.js";

const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h)).toISOString();
const w = (over: {
  state?: "running" | "paused";
  cron?: string;
  health?: RunHealthState;
  marks?: RunMarkEntry[];
  pendingApprovals?: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}) => ({
  state: over.state ?? ("running" as const),
  profileSlug: "issue",
  activator: over.cron
    ? { on: "schedule" as const, cron: over.cron, mode: "propose" as const }
    : { on: "created" as const, mode: "propose" as const },
  pendingApprovals: over.pendingApprovals ?? 0,
  lastRunAt: over.lastRunAt ?? null,
  nextRunAt: over.nextRunAt ?? null,
  health: {
    state: over.health ?? ("healthy" as const),
    marks: over.marks ?? [],
    consecutiveFailures: 0,
    offReason: null,
  },
});

describe("goalRunsRollup", () => {
  it("one reading from the goal's workers", () => {
    const r = goalRunsRollup([
      w({
        cron: "0 9 * * 1",
        marks: [
          { runId: "a1", mark: "done", at: at(1) },
          { runId: "a3", mark: "failed", at: at(3) },
        ],
        health: "failing",
        lastRunAt: at(3),
        nextRunAt: at(30),
      }),
      w({
        marks: [{ runId: "b2", mark: "done", at: at(2) }],
        pendingApprovals: 2,
        lastRunAt: at(2),
        nextRunAt: null,
      }),
      w({ state: "paused", health: "paused", nextRunAt: at(5) }),
    ]);
    expect(r).toEqual({
      rhythm: "Every Monday at 09:00 UTC · when an issue is created",
      health: "failing",
      workerCount: 3,
      runningCount: 2,
      pendingApprovals: 2,
      marks: [
        { runId: "a1", mark: "done", at: at(1) },
        { runId: "b2", mark: "done", at: at(2) },
        { runId: "a3", mark: "failed", at: at(3) },
      ],
      lastRunAt: at(3),
      // A paused worker's clock is not the goal's next run.
      nextRunAt: at(30),
    });
  });

  it("a goal with no worker: nothing wakes it, not running", () => {
    expect(goalRunsRollup([])).toEqual({
      rhythm: null,
      health: "not_running",
      workerCount: 0,
      runningCount: 0,
      pendingApprovals: 0,
      marks: [],
      lastRunAt: null,
      nextRunAt: null,
    });
  });
});
