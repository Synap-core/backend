import { describe, it, expect } from "vitest";
import { SESSION_STATUSES } from "../focus-sessions/statuses.js";
import { resolveUnitState } from "./state.js";
import {
  STEP_READINESS_STATES,
  deriveStepReadiness,
  isStepDate,
  isStepReadyToWake,
  openBlockerTitle,
  openBlockersOf,
  pathRowUnitView,
  sessionUnitInput,
  stepDateStart,
  stepTimeOf,
  stepWindowReached,
  type StepReadinessFacts,
} from "./session.js";

/**
 * THE readiness rule of a plan step (P1, C5). Each row names the naive rule
 * it rules OUT: a row every plausible rule agrees on is decoration.
 */
const NOW = Date.UTC(2026, 10, 21, 12); // 21 Nov 2026, 12:00 UTC
const OPEN = { dropped: false };
const DROPPED = { dropped: true };

const readiness = (facts: Partial<StepReadinessFacts>) =>
  deriveStepReadiness({
    status: "forming",
    openBlockers: [],
    now: NOW,
    ...facts,
  });

describe("deriveStepReadiness — a step not started", () => {
  it("nothing holds it and no date: ready (rules out 'forming is always planned')", () => {
    expect(readiness({})).toBe("ready");
    expect(readiness({ status: "scheduled" })).toBe("ready");
  });

  it("an open blocker: planned, it moves by itself (rules out 'any blocker is blocked')", () => {
    expect(readiness({ openBlockers: [OPEN] })).toBe("planned");
  });

  it("a DROPPED blocker: blocked, it never moves by itself (rules out 'dropped waits like open')", () => {
    expect(readiness({ openBlockers: [OPEN, DROPPED] })).toBe("blocked");
  });

  it("a FAILED blocker read: planned, never ready on a guess", () => {
    expect(readiness({ openBlockers: null })).toBe("planned");
  });

  it("its window opens at the first instant of the planned month or day (UTC)", () => {
    expect(readiness({ plannedFor: "2026-12" })).toBe("planned");
    expect(readiness({ plannedFor: "2026-11" })).toBe("ready");
    expect(readiness({ plannedFor: "2026-11-22" })).toBe("planned");
    expect(readiness({ plannedFor: "2026-11-21" })).toBe("ready");
    const dec1 = Date.UTC(2026, 11, 1);
    expect(readiness({ plannedFor: "2026-12", now: dec1 - 1 })).toBe("planned");
    expect(readiness({ plannedFor: "2026-12", now: dec1 })).toBe("ready");
    expect(
      readiness({ plannedFor: "2026-11-21T13:00:00+01:00", now: NOW })
    ).toBe("ready");
    expect(readiness({ plannedFor: "2026-11-21T13:00:00Z", now: NOW })).toBe(
      "planned"
    );
  });

  it("blockers AND date: both must clear (rules out 'date alone wakes it')", () => {
    expect(readiness({ plannedFor: "2026-01", openBlockers: [OPEN] })).toBe(
      "planned"
    );
  });

  it("an unreadable date never starts work early", () => {
    for (const bad of [
      "2027-02-30",
      "soon",
      "2026-13",
      "2026-1",
      "2026-11-21T10:00",
    ]) {
      expect(readiness({ plannedFor: bad }), bad).toBe("planned");
    }
  });
});

describe("deriveStepReadiness — started and ended", () => {
  it("started: active unless a blocker still holds it", () => {
    for (const status of ["active", "paused", "stale"]) {
      expect(readiness({ status }), status).toBe("active");
      expect(readiness({ status, openBlockers: [OPEN] }), status).toBe(
        "blocked"
      );
      // A started step claims no block it cannot see.
      expect(readiness({ status, openBlockers: null }), status).toBe("active");
    }
  });

  it("a started step ignores its planned date (rules out 'a future date un-starts it')", () => {
    expect(readiness({ status: "active", plannedFor: "2030-01" })).toBe(
      "active"
    );
  });

  it("ended: done only when it DELIVERED; skipped wins for an arm not taken", () => {
    expect(readiness({ status: "closed" })).toBe("done");
    expect(readiness({ status: "closed", closedAs: "not_done" })).toBe(
      "dropped"
    );
    expect(readiness({ status: "cancelled" })).toBe("dropped");
    expect(readiness({ status: "failed" })).toBe("dropped");
    expect(readiness({ status: "cancelled", skipped: true })).toBe("skipped");
    // An ended step is ended, whatever its blockers say.
    expect(readiness({ status: "closed", openBlockers: [DROPPED] })).toBe(
      "done"
    );
  });

  it("every stored status lands on one declared readiness (derived, non-vacuous)", () => {
    expect(SESSION_STATUSES.length).toBeGreaterThanOrEqual(8);
    const seen = new Set<string>();
    for (const status of SESSION_STATUSES) {
      for (const openBlockers of [[], [OPEN], [DROPPED], null]) {
        const r = readiness({ status, openBlockers });
        expect(STEP_READINESS_STATES).toContain(r);
        seen.add(r);
      }
    }
    // `skipped` needs its own fact; every other word is reachable.
    expect([...seen].sort()).toEqual(
      STEP_READINESS_STATES.filter((s) => s !== "skipped").sort()
    );
  });
});

describe("isStepReadyToWake — what the pod wakes", () => {
  it("only a PLANNED (forming) step that is ready", () => {
    expect(
      isStepReadyToWake({ status: "forming", openBlockers: [], now: NOW })
    ).toBe(true);
    // An appointment opens on its own clock, never here.
    expect(
      isStepReadyToWake({ status: "scheduled", openBlockers: [], now: NOW })
    ).toBe(false);
    expect(
      isStepReadyToWake({ status: "active", openBlockers: [], now: NOW })
    ).toBe(false);
    expect(
      isStepReadyToWake({ status: "forming", openBlockers: [OPEN], now: NOW })
    ).toBe(false);
    expect(
      isStepReadyToWake({
        status: "forming",
        openBlockers: [],
        plannedFor: "2027-01",
        now: NOW,
      })
    ).toBe(false);
  });
});

describe("openBlockersOf — a path row's blockers through THE dependency rule", () => {
  it("delivered clears, dropped is marked, an unread section is null", () => {
    const edges = {
      status: "ok" as const,
      items: [
        { title: "Spec", status: "closed" },
        { title: "Pitch", status: "closed", closedAs: "not_done" as const },
        { title: "Deck", status: "active" },
        { title: "Old", status: "cancelled" },
      ],
    };
    expect(openBlockersOf(edges)).toEqual([
      { title: "Pitch", dropped: true },
      { title: "Deck", dropped: false },
      { title: "Old", dropped: true },
    ]);
    expect(openBlockerTitle(edges)).toBe("Pitch");
    expect(openBlockersOf({ status: "unavailable" })).toBeNull();
    expect(openBlockersOf(undefined)).toBeNull();
    expect(openBlockerTitle({ status: "unavailable" })).toBeNull();
  });
});

describe("a step's dates", () => {
  it("stepDateStart reads a month, a day and an ISO date-time with its offset", () => {
    expect(stepDateStart("2027-03")).toBe(Date.UTC(2027, 2, 1));
    expect(stepDateStart("2027-03-14")).toBe(Date.UTC(2027, 2, 14));
    expect(stepDateStart("2027-03-14T09:30:00+02:00")).toBe(
      Date.UTC(2027, 2, 14, 7, 30)
    );
    expect(stepDateStart("2027-02-29")).toBeNull();
    expect(stepDateStart("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
    expect(stepDateStart("")).toBeNull();
    expect(stepDateStart(null)).toBeNull();
  });

  it("isStepDate is the door's check; stepTimeOf keeps only valid values", () => {
    expect(isStepDate("2027-03")).toBe(true);
    expect(isStepDate("March")).toBe(false);
    expect(isStepDate(20270301)).toBe(false);
    expect(
      stepTimeOf({ plannedFor: "2027-03", dueBy: "next week", other: 1 })
    ).toEqual({ plannedFor: "2027-03", dueBy: null });
    expect(stepTimeOf(null)).toEqual({ plannedFor: null, dueBy: null });
    expect(stepTimeOf(["2027-03"])).toEqual({ plannedFor: null, dueBy: null });
  });

  it("stepWindowReached: no date is reached, a malformed one is not", () => {
    expect(stepWindowReached(null, NOW)).toBe(true);
    expect(stepWindowReached(undefined, NOW)).toBe(true);
    expect(stepWindowReached("bad", NOW)).toBe(false);
  });
});

describe("a PLANNED step's mark (forming is not running, P1)", () => {
  const live = { turnInFlight: true, lastAt: new Date(NOW).toISOString() };
  const mark = (status: string, blockedBy: string | null = null) =>
    resolveUnitState(
      sessionUnitInput({ status, owedFromYou: 0, blockedBy, now: NOW })
    ).state;

  it("reads not started, never working (rules out the old 'forming is running')", () => {
    expect(mark("forming")).toBe("not_started");
    expect(mark("active")).toBe("working");
    // Even a measured turn in its room does not make a planned step run.
    expect(
      resolveUnitState(
        sessionUnitInput({
          status: "forming",
          owedFromYou: 0,
          live,
          now: NOW,
        })
      ).state
    ).toBe("not_started");
  });

  it("a planned step waiting on another reads blocked, like an active one", () => {
    expect(mark("forming", "Term sheet")).toBe("blocked");
  });

  it("a path row reads the same through the one door", () => {
    expect(
      pathRowUnitView({
        status: "forming",
        unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
      }).state
    ).toBe("not_started");
  });
});
