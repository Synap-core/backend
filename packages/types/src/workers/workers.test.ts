import { describe, expect, it } from "vitest";
import { AUTOMATION_SKIP_REASONS } from "../automations/rule-run-policy.js";
import { humanizeToken, resolveStatusLabel } from "../vocabulary/index.js";
import {
  WORKER_SKIP_REASONS,
  WORKER_TARGET_REASONS,
  WORKER_TARGET_RESULTS,
  WORKER_TARGET_ROLE,
  effectiveWorkerSize,
  readWorkerTargetMetadata,
} from "./index.js";

describe("worker skip reasons", () => {
  it("every worker skip reason is an automation skip reason (one run-row vocabulary)", () => {
    const automation = new Set<string>(Object.values(AUTOMATION_SKIP_REASONS));
    const worker = Object.values(WORKER_SKIP_REASONS);
    expect(worker.length).toBe(4);
    for (const r of worker) expect(automation.has(r)).toBe(true);
  });

  it("reads as words, never a raw token", () => {
    expect(humanizeToken(WORKER_SKIP_REASONS.approvalsBacklog)).toBe(
      "Approvals backlog"
    );
    expect(humanizeToken(WORKER_TARGET_REASONS.movedByPerson)).toBe(
      "Moved by person"
    );
  });
});

describe("worker target results", () => {
  it("every result has a status word in the one vocabulary", () => {
    expect(WORKER_TARGET_RESULTS.map(resolveStatusLabel)).toEqual([
      "Done",
      "Failed",
      "Skipped",
      "Created",
    ]);
  });

  it("reads only worker-target edges", () => {
    expect(readWorkerTargetMetadata({ role: "input", via: "x" })).toBeNull();
    expect(readWorkerTargetMetadata(null)).toBeNull();
    expect(readWorkerTargetMetadata({ role: WORKER_TARGET_ROLE })).toEqual({
      role: "worker_target",
    });
  });

  it("an unknown result reads as still being worked, not a leaked token", () => {
    expect(
      readWorkerTargetMetadata({ role: WORKER_TARGET_ROLE, result: "exploded" })
    ).toEqual({ role: "worker_target" });
    expect(
      readWorkerTargetMetadata({
        role: WORKER_TARGET_ROLE,
        result: "skipped",
        reason: "moved_by_person",
        at: "2026-10-12T00:00:00.000Z",
        transitionEventId: "t1",
      })
    ).toEqual({
      role: "worker_target",
      result: "skipped",
      reason: "moved_by_person",
      at: "2026-10-12T00:00:00.000Z",
      transitionEventId: "t1",
    });
  });
});

describe("effectiveWorkerSize", () => {
  it("count is always per_moment; default per_thing", () => {
    expect(effectiveWorkerSize({ on: "count", size: "per_thing" })).toBe(
      "per_moment"
    );
    expect(effectiveWorkerSize({ on: "enters_status" })).toBe("per_thing");
    expect(effectiveWorkerSize({ on: "schedule", size: "per_moment" })).toBe(
      "per_moment"
    );
  });
});
