/**
 * Contract tests for the automation-health warden's PURE tier.
 *
 * DB-FREE BY CONSTRUCTION, not by mocking: `automation-health-predicate.ts` has
 * ZERO imports, so nothing here needs a stub, a fake pool, or a migrated
 * Postgres. Every qualification rule the warden acts on is proven right here.
 *
 * The one property that must never regress is pinned first: the detector is
 * EFFECT-BASED. It reads the ABSENCE of runs, never a run's reported status, so
 * a status field that lies (the mid-stream death logged as `finishReason:
 * "stop"`) cannot make it certify a dead automation healthy or a live one dead.
 */

import { describe, it, expect } from "vitest";
import {
  detectZeroRunAutomations,
  zeroRunItemRef,
  AUTOMATION_STATUSES,
  FIRING_STATUSES,
  PRODUCER_BACKED_TRIGGERS,
  DEFAULT_MIN_AGE_DAYS,
  type AutomationHealthRow,
} from "./automation-health-predicate.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

function automation(
  over: Partial<AutomationHealthRow> & { id: string }
): AutomationHealthRow {
  return {
    name: `automation ${over.id}`,
    status: "active",
    triggerType: "event",
    workspaceId: "ws-1",
    createdBy: "human-1",
    createdAt: daysAgo(60),
    ...over,
  };
}

function detect(
  rows: AutomationHealthRow[],
  runCounts: Record<string, number> = {},
  extra: { suppressed?: string[]; minAgeDays?: number } = {}
) {
  return detectZeroRunAutomations({
    automations: rows,
    runCountsByAutomationId: new Map(Object.entries(runCounts)),
    now: NOW,
    ...(extra.minAgeDays !== undefined ? { minAgeDays: extra.minAgeDays } : {}),
    ...(extra.suppressed
      ? { suppressedAutomationIds: new Set(extra.suppressed) }
      : {}),
  });
}

describe("detectZeroRunAutomations — the effect-based property", () => {
  it("fires on an enabled, old, never-run automation", () => {
    const found = detect([automation({ id: "a1" })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.automationId).toBe("a1");
    expect(found[0]!.runCount).toBe(0);
    expect(found[0]!.ageDays).toBe(60);
  });

  it("goes QUIET on ANY run row, whatever that run's outcome was — the count is the only run fact read", () => {
    // One run is one run. The predicate has no access to the run's status by
    // construction (its input is a COUNT), which is exactly what makes a lying
    // `finishReason`/`status` unable to influence this finding in either
    // direction. If a future refactor threads statuses in here, this test is
    // the one that should be made to fail rather than updated.
    expect(detect([automation({ id: "a1" })], { a1: 1 })).toEqual([]);
    expect(detect([automation({ id: "a1" })], { a1: 999 })).toEqual([]);
  });

  it("a missing key in the run-count map means zero, not unknown", () => {
    expect(detect([automation({ id: "a1" })], { other: 5 })).toHaveLength(1);
  });
});

describe("detectZeroRunAutomations — 'enabled' comes from the status vocabulary", () => {
  it("fires ONLY for statuses in FIRING_STATUSES, across the whole vocabulary", () => {
    // Enumerated over the REAL vocabulary rather than a hand-picked pair, so a
    // newly added status is automatically exercised here the moment the parity
    // test forces it into AUTOMATION_STATUSES.
    for (const status of AUTOMATION_STATUSES) {
      const found = detect([automation({ id: "a1", status })]);
      const shouldFire = (FIRING_STATUSES as readonly string[]).includes(
        status
      );
      expect(
        found.length,
        `status "${status}" should ${shouldFire ? "" : "NOT "}fire`
      ).toBe(shouldFire ? 1 : 0);
    }
  });

  it("draft is silent — the three CP cron seeds that ship status:'draft' must not become health noise", () => {
    expect(detect([automation({ id: "seed", status: "draft" })])).toEqual([]);
  });

  it("archived is silent — it CANNOT fire by construction, so 'never fired' is not a defect", () => {
    expect(detect([automation({ id: "a1", status: "archived" })])).toEqual([]);
  });
});

describe("detectZeroRunAutomations — producer-backed triggers only", () => {
  it("fires for event / cron / webhook and stays silent for manual", () => {
    for (const triggerType of ["event", "cron", "webhook", "manual"]) {
      const found = detect([automation({ id: "a1", triggerType })]);
      const shouldFire = (
        PRODUCER_BACKED_TRIGGERS as readonly string[]
      ).includes(triggerType);
      expect(found.length, `trigger "${triggerType}"`).toBe(shouldFire ? 1 : 0);
    }
  });

  it("the WHY names the missing producer per trigger type, not a generic 'stale'", () => {
    const byTrigger = Object.fromEntries(
      ["event", "cron", "webhook"].map((t) => [
        t,
        detect([automation({ id: `a-${t}`, triggerType: t })])[0]!.why,
      ])
    );
    expect(byTrigger.event).toContain("producer");
    expect(byTrigger.cron).toContain("cron");
    expect(byTrigger.webhook).toContain("webhook");
    // Three distinct sentences — a shared generic string would be a regression.
    expect(new Set(Object.values(byTrigger)).size).toBe(3);
  });
});

describe("detectZeroRunAutomations — the grace period", () => {
  it("a young automation is not yet a finding", () => {
    expect(detect([automation({ id: "a1", createdAt: daysAgo(3) })])).toEqual(
      []
    );
  });

  it("the boundary is inclusive at exactly minAgeDays", () => {
    expect(
      detect([
        automation({ id: "a1", createdAt: daysAgo(DEFAULT_MIN_AGE_DAYS) }),
      ])
    ).toHaveLength(1);
    expect(
      detect([
        automation({ id: "a1", createdAt: daysAgo(DEFAULT_MIN_AGE_DAYS - 1) }),
      ])
    ).toEqual([]);
  });

  it("honours an overridden minAgeDays", () => {
    expect(
      detect(
        [automation({ id: "a1", createdAt: daysAgo(5) })],
        {},
        { minAgeDays: 3 }
      )
    ).toHaveLength(1);
  });
});

describe("detectZeroRunAutomations — the re-nag guard bites in the predicate", () => {
  it("a suppressed automation produces no finding even though it otherwise qualifies", () => {
    const rows = [automation({ id: "a1" }), automation({ id: "a2" })];
    expect(detect(rows)).toHaveLength(2);
    expect(
      detect(rows, {}, { suppressed: ["a1"] }).map((f) => f.automationId)
    ).toEqual(["a2"]);
  });
});

describe("detectZeroRunAutomations — the evidence a reviewer acts on", () => {
  it("carries created date, age, zero-run and trigger type on every item", () => {
    const created = daysAgo(45);
    const [f] = detect([
      automation({
        id: "a1",
        name: "Weekly digest",
        createdAt: created,
        triggerType: "cron",
      }),
    ]);
    expect(f).toMatchObject({
      automationId: "a1",
      name: "Weekly digest",
      triggerType: "cron",
      status: "active",
      workspaceId: "ws-1",
      createdBy: "human-1",
      createdAt: created.toISOString(),
      ageDays: 45,
      runCount: 0,
    });
    expect(f!.why).toBeTruthy();
  });

  it("the item ref is stable across scans and derived from the automation id — a persisted disposition depends on it", () => {
    const rows = [automation({ id: "a1" })];
    expect(detect(rows)[0]!.ref).toBe(zeroRunItemRef("a1"));
    expect(detect(rows)[0]!.ref).toBe(detect(rows)[0]!.ref);
    expect(zeroRunItemRef("a1")).not.toBe(zeroRunItemRef("a2"));
  });

  it("orders oldest-first so the most certain dead wire leads", () => {
    const found = detect([
      automation({ id: "young", createdAt: daysAgo(20) }),
      automation({ id: "old", createdAt: daysAgo(300) }),
      automation({ id: "mid", createdAt: daysAgo(90) }),
    ]);
    expect(found.map((f) => f.automationId)).toEqual(["old", "mid", "young"]);
  });

  it("is pure — the same inputs give a deeply equal result", () => {
    const rows = [automation({ id: "a1" }), automation({ id: "a2" })];
    expect(detect(rows)).toEqual(detect(rows));
  });
});
