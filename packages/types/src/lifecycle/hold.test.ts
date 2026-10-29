/**
 * The hold rule and the occurred-time bounds (status-flow W4), pure: what
 * every status door (entity, goal, session) applies through `decideMoveHold`
 * and `resolveOccurredAt`.
 */
import { describe, expect, it } from "vitest";
import {
  HOLD_REQUIRED_MESSAGE,
  HOLD_UNSPECIFIED_BY_AGENT_MESSAGE,
  decideMoveHold,
  holdWokenBy,
  resolveOccurredAt,
  type RecordedHold,
} from "./hold.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const DAY = 86_400_000;
const pause = {
  from: "active",
  fromCategory: "active",
  toCategory: "paused",
  since: NOW,
} as const;

describe("decideMoveHold", () => {
  it("refuses an agent's pause without a hold, naming the field", () => {
    const d = decideMoveHold({ ...pause, actorKind: "agent" });
    expect(d).toEqual({
      ok: false,
      code: "HOLD_REQUIRED",
      message: HOLD_REQUIRED_MESSAGE,
    });
    expect(HOLD_REQUIRED_MESSAGE).toContain("`hold`");
  });

  it("records a person's pause without a hold as unspecified, reviewed in 14 days", () => {
    const d = decideMoveHold({ ...pause, actorKind: "human" });
    expect(d).toEqual({
      ok: true,
      hold: {
        on: "unspecified",
        ref: null,
        reason: null,
        until: null,
        reviewBy: new Date(NOW.getTime() + 14 * DAY).toISOString(),
        resumeTo: "active",
        since: NOW.toISOString(),
      },
    });
  });

  it("records the system's pause with its own fallback, 7 days for a run", () => {
    const d = decideMoveHold({
      ...pause,
      actorKind: "system",
      fallback: { on: "nobody", reason: "idle" },
      base: "run",
    });
    expect(d.ok && d.hold).toMatchObject({
      on: "nobody",
      reason: "idle",
      reviewBy: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    });
  });

  it("stores a given review date in the one stamp shape the watcher compares", () => {
    const d = decideMoveHold({
      ...pause,
      actorKind: "agent",
      given: { on: "external", reviewBy: "2026-12-01" },
    });
    expect(d.ok && d.hold.reviewBy).toBe("2026-12-01T00:00:00.000Z");
  });

  it("takes an agent's hold; a dated resume needs no review date", () => {
    const until = { date: "2026-11-10T00:00:00.000Z" };
    const d = decideMoveHold({
      ...pause,
      actorKind: "agent",
      given: { on: "external", ref: "company:acme", until },
    });
    expect(d.ok && d.hold).toMatchObject({
      on: "external",
      ref: "company:acme",
      until,
      reviewBy: null,
      resumeTo: "active",
    });
  });

  it("refuses a hold whose date has passed, and a moves ref naming no subject", () => {
    expect(
      decideMoveHold({
        ...pause,
        actorKind: "human",
        given: { on: "date", until: { date: "2026-10-01" } },
      })
    ).toMatchObject({ ok: false, code: "HOLD_INVALID" });
    expect(
      decideMoveHold({
        ...pause,
        actorKind: "human",
        given: { on: "thing", until: { moves: "proposal:p1" } },
      })
    ).toMatchObject({ ok: false, code: "HOLD_INVALID" });
  });

  it("refuses a hold on a move that is not a pause; none needed there", () => {
    const resume = {
      ...pause,
      from: "on-hold",
      fromCategory: "paused",
      toCategory: "active",
    };
    expect(
      decideMoveHold({ ...resume, actorKind: "agent", given: { on: "nobody" } })
    ).toMatchObject({ ok: false, code: "HOLD_NOT_A_PAUSE" });
    expect(decideMoveHold({ ...resume, actorKind: "agent" })).toEqual({
      ok: true,
      hold: null,
    });
  });

  it("carries the hold in force across a paused → paused move (the reaper's stale)", () => {
    const current: RecordedHold = {
      on: "person",
      until: { date: "2026-11-10T00:00:00.000Z" },
      resumeTo: "active",
      since: "2026-10-20T00:00:00.000Z",
    };
    const stale = {
      ...pause,
      from: "paused",
      fromCategory: "paused",
      actorKind: "system" as const,
      fallback: { on: "nobody" as const },
    };
    expect(decideMoveHold({ ...stale, current })).toEqual({
      ok: true,
      hold: current,
    });
    // An agent need not restate it either.
    expect(decideMoveHold({ ...stale, actorKind: "agent", current })).toEqual({
      ok: true,
      hold: current,
    });
    // A new hold replaces it but keeps where the pause began.
    const d = decideMoveHold({
      ...stale,
      current,
      given: { on: "decision", ref: "stage:review" },
    });
    expect(d.ok && d.hold).toMatchObject({
      on: "decision",
      resumeTo: "active",
    });
  });
});

describe("decideMoveHold — review fixes", () => {
  const passed = {
    on: "external" as const,
    until: { date: "2026-10-20T00:00:00.000Z" },
  };

  it("an approved replay keeps a hold whose date passed while the proposal waited", () => {
    // Refused when filed now…
    expect(
      decideMoveHold({ ...pause, actorKind: "agent", given: passed, now: NOW })
    ).toMatchObject({ ok: false, code: "HOLD_INVALID" });
    // …but a person approved it: only its SHAPE is checked; the sweep resumes it.
    const d = decideMoveHold({
      ...pause,
      actorKind: "agent",
      approved: true,
      given: passed,
      now: NOW,
    });
    expect(d.ok && d.hold).toMatchObject({
      on: "external",
      until: passed.until,
    });
    // A malformed one is still refused.
    expect(
      decideMoveHold({
        ...pause,
        actorKind: "agent",
        approved: true,
        given: { on: "thing", until: { moves: "nope" } },
      })
    ).toMatchObject({ ok: false, code: "HOLD_INVALID" });
  });

  it("an agent's `unspecified` is refused, unless a person approved the move", () => {
    expect(
      decideMoveHold({
        ...pause,
        actorKind: "agent",
        given: { on: "unspecified" },
      })
    ).toEqual({
      ok: false,
      code: "HOLD_INVALID",
      message: HOLD_UNSPECIFIED_BY_AGENT_MESSAGE,
    });
    expect(
      decideMoveHold({
        ...pause,
        actorKind: "agent",
        approved: true,
        given: { on: "unspecified" },
      }).ok
    ).toBe(true);
    // The agent-facing list names `nobody` and never offers `unspecified`.
    expect(HOLD_REQUIRED_MESSAGE).toContain('"nobody"');
    expect(HOLD_REQUIRED_MESSAGE).not.toContain("unspecified");
  });

  it("already paused with no hold on record (before holds): the fallback, not a refusal", () => {
    const d = decideMoveHold({
      ...pause,
      from: "stale",
      fromCategory: "paused",
      actorKind: "agent",
      current: null,
    });
    expect(d.ok && d.hold).toMatchObject({ on: "unspecified", resumeTo: null });
  });

  it("a hold's dates are checked against NOW, not the backdated occurred time", () => {
    const since = new Date(NOW.getTime() - 20 * DAY);
    // Ahead of `since`, behind now: passed — refused.
    expect(
      decideMoveHold({
        ...pause,
        since,
        now: NOW,
        actorKind: "human",
        given: {
          on: "date",
          until: { date: new Date(NOW.getTime() - 5 * DAY).toISOString() },
        },
      })
    ).toMatchObject({ ok: false, code: "HOLD_INVALID" });
    const d = decideMoveHold({
      ...pause,
      since,
      now: NOW,
      actorKind: "human",
      given: {
        on: "date",
        until: { date: new Date(NOW.getTime() + DAY).toISOString() },
      },
    });
    expect(d.ok && d.hold).toMatchObject({ since: since.toISOString() });
  });
});

describe("resolveOccurredAt", () => {
  it("defaults to now, not backdated", () => {
    expect(resolveOccurredAt(undefined, NOW)).toEqual({
      ok: true,
      occurredAt: NOW,
      recordedAt: NOW,
      backdated: false,
    });
  });

  it("accepts up to 30 days back, marked backdated", () => {
    const at = new Date(NOW.getTime() - 29 * DAY);
    expect(resolveOccurredAt(at.toISOString(), NOW)).toEqual({
      ok: true,
      occurredAt: at,
      recordedAt: NOW,
      backdated: true,
    });
  });

  it("refuses more than 30 days back, the future, and a non-date", () => {
    expect(
      resolveOccurredAt(new Date(NOW.getTime() - 31 * DAY).toISOString(), NOW)
    ).toMatchObject({ ok: false, message: expect.stringContaining("30 days") });
    expect(
      resolveOccurredAt(new Date(NOW.getTime() + 60_000).toISOString(), NOW)
    ).toMatchObject({ ok: false, message: expect.stringContaining("future") });
    expect(resolveOccurredAt("last tuesday", NOW)).toMatchObject({ ok: false });
  });
});

describe("holdWokenBy", () => {
  const moved = {
    subjectType: "entity",
    subjectId: "e1",
    to: "signed",
    category: "done",
  };
  it("wakes on the awaited thing's move, filtered by status or category", () => {
    expect(holdWokenBy({ moves: "entity:e1" }, moved)).toBe(true);
    expect(holdWokenBy({ moves: "entity:e1", to: "done" }, moved)).toBe(true);
    expect(holdWokenBy({ moves: "entity:e1", to: "signed" }, moved)).toBe(true);
    expect(holdWokenBy({ moves: "entity:e1", to: "lost" }, moved)).toBe(false);
    expect(holdWokenBy({ moves: "entity:e2" }, moved)).toBe(false);
    expect(holdWokenBy({ date: "2026-11-10" }, moved)).toBe(false);
  });
});
