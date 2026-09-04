import { describe, it, expect } from "vitest";
import { classifyRunStall, classifyStalls } from "./stall.js";
import { summarizeGlobalHealth } from "./global.js";

/**
 * PINS the defect this signal exists for. Verified live 2026-08-16: a session
 * run sat `status=running` since 18:40 with no completion while diagnose
 * reported "No stuck runs" — because the ONLY signal was age past 24h.
 *
 * These tests also pin the two ways this class of check goes wrong:
 *   • an always-red check (idle must clear when activity resumes),
 *   • absence read as health (a run with no progress column is UNOBSERVABLE,
 *     never "fine").
 */

const NOW = new Date("2026-08-16T02:00:00Z").getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const OPTS = { agedHours: 24, idleMinutes: 45 };

function run(over: Partial<Parameters<typeof classifyRunStall>[0]> = {}) {
  return {
    id: "run-1",
    flowType: "session" as const,
    flowName: "Vérifier le raccordement de la session",
    startedAt: new Date(NOW - 3 * HOUR),
    lastActivityAt: new Date(NOW - 3 * HOUR),
    ...over,
  };
}

describe("classifyRunStall", () => {
  it("catches the live defect: 3h old, no progress for 3h → idle in minutes, not a day", () => {
    expect(classifyRunStall(run(), NOW, OPTS)).toBe("idle");
  });

  it("a young run whose progress is fresh is ok", () => {
    expect(
      classifyRunStall(
        run({ lastActivityAt: new Date(NOW - 5 * MIN) }),
        NOW,
        OPTS
      )
    ).toBe("ok");
  });

  it("a LONG-lived run that keeps progressing is ok — age alone is not a hang", () => {
    expect(
      classifyRunStall(
        run({
          startedAt: new Date(NOW - 20 * HOUR),
          lastActivityAt: new Date(NOW - 2 * MIN),
        }),
        NOW,
        OPTS
      )
    ).toBe("ok");
  });

  it("GREEN AGAIN: activity resuming clears idle with no reset step", () => {
    const stalled = run();
    expect(classifyRunStall(stalled, NOW, OPTS)).toBe("idle");
    const resumed = { ...stalled, lastActivityAt: new Date(NOW - 1 * MIN) };
    expect(classifyRunStall(resumed, NOW, OPTS)).toBe("ok");
  });

  it("aged outranks idle so one run is never counted twice", () => {
    expect(
      classifyRunStall(
        run({
          startedAt: new Date(NOW - 30 * HOUR),
          lastActivityAt: new Date(NOW - 30 * HOUR),
        }),
        NOW,
        OPTS
      )
    ).toBe("aged");
  });

  it("null lastActivityAt is UNKNOWN, never 'no activity'", () => {
    expect(classifyRunStall(run({ lastActivityAt: null }), NOW, OPTS)).toBe(
      "ok"
    );
  });
});

describe("classifyStalls", () => {
  it("counts unobservable runs instead of folding them into 'all clear'", () => {
    const report = classifyStalls(
      [
        run({ id: "a", lastActivityAt: null }),
        run({ id: "b", flowType: "automation", lastActivityAt: null }),
        run({ id: "c", lastActivityAt: new Date(NOW - 2 * MIN) }),
      ],
      NOW,
      OPTS
    );
    expect(report.aged).toHaveLength(0);
    expect(report.idle).toHaveLength(0);
    expect(report.unobservable).toBe(2);
  });

  it("sorts idle worst-first and reports the idle duration", () => {
    const report = classifyStalls(
      [
        run({ id: "mild", lastActivityAt: new Date(NOW - 50 * MIN) }),
        run({ id: "severe", lastActivityAt: new Date(NOW - 200 * MIN) }),
      ],
      NOW,
      OPTS
    );
    expect(report.idle.map((r) => r.id)).toEqual(["severe", "mild"]);
    expect(Math.round(report.idle[0]!.idleMinutes!)).toBe(200);
  });
});

describe("summarizeGlobalHealth — stuck_runs section", () => {
  const base = {
    stuckHours: 24,
    stuck: [],
    failedFlows: [],
    backlog: { pending: 0, oldestAgeHours: null, mineOutsideLens: 0 },
    duplicateClusters: [],
    capabilities: { enabled: 1, unapproved: 0 },
    agentActivity: [],
  };

  it("no longer prints 'No stuck runs' over an idle run", () => {
    const report = summarizeGlobalHealth(
      {
        ...base,
        idleMinutes: 45,
        stall: {
          aged: [],
          idle: [
            {
              id: "r1",
              flowType: "session",
              flowName: "Session",
              ageHours: 3,
              idleMinutes: 180,
              verdict: "idle" as const,
            },
          ],
          unobservable: 0,
        },
      },
      { workspaceId: null }
    );
    const section = report.sections.find((s) => s.key === "stuck_runs");
    expect(section?.status).toBe("attention");
    expect(section?.headline).toContain("idle");
    expect(report.status).toBe("attention");
  });

  it("keeps `count`/`oldest` meaning the AGED list — existing consumers unmoved", () => {
    const report = summarizeGlobalHealth(
      {
        ...base,
        stuck: [
          { id: "r9", flowType: "playbook", flowName: "P", ageHours: 30 },
        ],
        idleMinutes: 45,
        stall: { aged: [], idle: [], unobservable: 4 },
      },
      { workspaceId: null }
    );
    const section = report.sections.find((s) => s.key === "stuck_runs");
    expect(section?.status).toBe("degraded");
    expect(section?.detail.count).toBe(1);
    expect(section?.detail.unobservableRunning).toBe(4);
  });

  it("is honest-empty when nothing is aged, idle, or unobservable", () => {
    const report = summarizeGlobalHealth(
      {
        ...base,
        idleMinutes: 45,
        stall: { aged: [], idle: [], unobservable: 0 },
      },
      { workspaceId: null }
    );
    expect(report.sections.find((s) => s.key === "stuck_runs")?.headline).toBe(
      "No stuck runs"
    );
  });
});
