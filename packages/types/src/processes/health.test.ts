/**
 * The process health rule, moved from the browser processors app with its
 * tests (`processes-model.test.ts` `deriveProcessHealth` and "waiting run →
 * its session", browser origin/main 16 Nov 2026). Same cases, same answers.
 */
import { describe, expect, it } from "vitest";
import {
  deriveProcessHealth,
  processHealthNeedsAttention,
  sessionIdOfRunMark,
  type ProcessRunGroup,
  type ProcessRunMark,
} from "./health.js";

function run(overrides: Partial<ProcessRunMark> = {}): ProcessRunMark {
  return {
    id: "run-1",
    status: "completed",
    startedAt: new Date("2026-07-30T12:00:00Z"),
    completedAt: new Date("2026-07-30T12:01:00Z"),
    sessionId: null,
    ...overrides,
  };
}

function group(overrides: Partial<ProcessRunGroup> = {}): ProcessRunGroup {
  return {
    runCount: 1,
    latestRunId: "run-1",
    latestStatus: "completed",
    latestStartedAt: new Date("2026-07-30T12:00:00Z"),
    hasRunning: false,
    completedCount: 1,
    failedCount: 0,
    recentFailedCount: 0,
    runningCount: 0,
    ...overrides,
  };
}

describe("deriveProcessHealth", () => {
  it("reads a run the reaper parked on the person as waiting-on-you — never a failure, never unresolved", () => {
    const waiting = run({
      id: "waiting",
      status: "waiting_on_you",
      startedAt: new Date("2026-07-30T11:00:00Z"),
      completedAt: null,
    });
    const earlierFailure = run({
      id: "old-failure",
      status: "failed",
      startedAt: new Date("2026-07-30T10:00:00Z"),
    });
    const health = deriveProcessHealth({
      definitionStatus: "active",
      runGroup: null,
      recentRuns: [waiting, earlierFailure],
      exactRunCount: 2,
    });
    expect(health).toMatchObject({
      state: "waiting-on-you",
      runId: "waiting",
      reason: "waiting_on_you",
    });
  });

  it("keeps configuration errors first and represents a live retry truthfully", () => {
    const failed = run({
      id: "failed",
      status: "failed",
      startedAt: new Date("2026-07-30T10:00:00Z"),
    });
    const running = run({
      id: "running",
      status: "running",
      startedAt: new Date("2026-07-30T11:00:00Z"),
    });
    expect(
      deriveProcessHealth({
        definitionStatus: "error",
        runGroup: group({ hasRunning: true, failedCount: 99 }),
        recentRuns: [running, failed],
        exactRunCount: 100,
      }).state
    ).toBe("config-error");
    expect(
      deriveProcessHealth({
        definitionStatus: "active",
        runGroup: group({
          latestRunId: "running",
          latestStatus: "running",
          latestStartedAt: new Date("2026-07-30T11:00:00Z"),
          hasRunning: true,
          failedCount: 99,
        }),
        recentRuns: [running, failed],
        exactRunCount: 100,
      })
    ).toMatchObject({
      state: "running",
      reason: "running_after_failure",
      runId: "running",
    });
  });

  it("treats a newer successful outcome as resolving an older failure", () => {
    expect(
      deriveProcessHealth({
        definitionStatus: "active",
        runGroup: group({
          latestRunId: "completed",
          failedCount: 99,
          completedCount: 1,
        }),
        recentRuns: [
          run({
            id: "failed",
            status: "failed",
            startedAt: new Date("2026-07-30T10:00:00Z"),
          }),
          run({
            id: "completed",
            status: "completed",
            startedAt: new Date("2026-07-30T12:00:00Z"),
          }),
        ],
        exactRunCount: 100,
      })
    ).toMatchObject({ state: "healthy", runId: "completed" });
  });

  it.each(["proposed", "cancelled"] as const)(
    "does not skip a newer %s execution to paint an older success healthy",
    (status) => {
      expect(
        deriveProcessHealth({
          definitionStatus: "active",
          runGroup: group({
            latestRunId: status,
            latestStatus: status,
            latestStartedAt: new Date("2026-07-30T12:00:00Z"),
          }),
          recentRuns: [
            run({
              id: status,
              status,
              startedAt: new Date("2026-07-30T12:00:00Z"),
            }),
            run({
              id: "completed",
              status: "completed",
              startedAt: new Date("2026-07-30T10:00:00Z"),
            }),
          ],
          exactRunCount: 2,
        })
      ).toMatchObject({
        state: "unknown",
        reason: "latest_unresolved",
        latestStatus: status,
        runId: status,
      });
    }
  );

  it("keeps definition lifecycle states ahead of healthy/never-run", () => {
    expect(
      deriveProcessHealth({
        definitionStatus: "draft",
        runGroup: group(),
        recentRuns: [run()],
        exactRunCount: 1,
      }).state
    ).toBe("draft");
    expect(
      deriveProcessHealth({
        definitionStatus: "paused",
        runGroup: group(),
        recentRuns: [run()],
        exactRunCount: 1,
      }).state
    ).toBe("paused");
  });

  it("distinguishes known never-run from incomplete activity evidence", () => {
    expect(
      deriveProcessHealth({
        definitionStatus: "active",
        runGroup: null,
        recentRuns: [],
        exactRunCount: 0,
      }).state
    ).toBe("never-run");
    expect(
      deriveProcessHealth({
        definitionStatus: "active",
        runGroup: null,
        recentRuns: [],
        exactRunCount: null,
      }).state
    ).toBe("unknown");
  });

  it("reads wire dates (ISO strings) exactly like Date objects", () => {
    const asDates = deriveProcessHealth({
      definitionStatus: "active",
      runGroup: group({
        latestRunId: "a",
        latestStartedAt: new Date("2026-07-30T10:00:00Z"),
      }),
      recentRuns: [
        run({
          id: "b",
          status: "failed",
          startedAt: new Date("2026-07-30T12:00:00Z"),
        }),
      ],
      exactRunCount: 2,
    });
    const asStrings = deriveProcessHealth({
      definitionStatus: "active",
      runGroup: group({
        latestRunId: "a",
        latestStartedAt: "2026-07-30T10:00:00Z",
      }),
      recentRuns: [
        run({ id: "b", status: "failed", startedAt: "2026-07-30T12:00:00Z" }),
      ],
      exactRunCount: 2,
    });
    expect(asStrings).toEqual(asDates);
    expect(asStrings).toMatchObject({
      state: "unresolved-failure",
      runId: "b",
    });
  });
});

describe("waiting run → its session (W2 review item 7)", () => {
  const waitingRun = (sessionId?: string | null): ProcessRunMark => ({
    ...run({ id: "w1", status: "waiting_on_you", completedAt: null }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  it("carries the session the waiting run drives onto the health", () => {
    expect(
      deriveProcessHealth({
        definitionStatus: "active",
        runGroup: null,
        recentRuns: [waitingRun("sess-9")],
        exactRunCount: 1,
      })
    ).toMatchObject({
      state: "waiting-on-you",
      runId: "w1",
      sessionId: "sess-9",
    });
  });

  it("no session on the wire (automation run, older pod) reads as null — never a guess", () => {
    for (const s of [undefined, null, ""]) {
      const mark = {
        ...waitingRun(),
        sessionId: s as string | null | undefined,
      };
      expect(sessionIdOfRunMark([mark], "w1")).toBeNull();
    }
    expect(sessionIdOfRunMark([waitingRun("sess-9")], "other-run")).toBeNull();
  });
});

describe("processHealthNeedsAttention", () => {
  it("names the four attention states and nothing calm", () => {
    expect(processHealthNeedsAttention({ state: "unresolved-failure" })).toBe(
      true
    );
    expect(processHealthNeedsAttention({ state: "waiting-on-you" })).toBe(true);
    expect(processHealthNeedsAttention({ state: "draft" })).toBe(false);
    expect(processHealthNeedsAttention({ state: "healthy" })).toBe(false);
  });
});
