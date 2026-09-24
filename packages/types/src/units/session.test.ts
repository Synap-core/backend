import { describe, it, expect } from "vitest";
import { resolveUnitState } from "./state.js";
import {
  sessionUnitInput,
  projectAggregateInput,
  sessionRowInput,
  type SessionUnitFacts,
} from "./session.js";

const stateOf = (facts: SessionUnitFacts) =>
  resolveUnitState(sessionUnitInput(facts)).state;

/**
 * Each case names the rule it would rule OUT. A row that every plausible
 * mapping agrees on is decoration, so the interesting rows are the ones where
 * a naive status→state table would answer differently.
 */
describe("sessionUnitInput — one session", () => {
  it("an active session with pending proposals is needs_review, not working", () => {
    // Rules out the old Relay mapping, which never passed pendingDecisions.
    expect(
      stateOf({ status: "active", owedFromYou: 0, pendingDecisions: 2 })
    ).toBe("needs_review");
  });

  it("a slot owed by the person outranks pending proposals", () => {
    expect(
      stateOf({ status: "active", owedFromYou: 1, pendingDecisions: 2 })
    ).toBe("needs_you");
  });

  it("stale is unmeasured, never working", () => {
    // Rules out letting `stale` fall to the default working arm.
    expect(stateOf({ status: "stale", owedFromYou: 0 })).toBe("unmeasured");
  });

  it("a failed proposals read does not silence a running session", () => {
    // An unknown removes only the calm answer, never a live one.
    expect(
      stateOf({ status: "active", owedFromYou: 0, pendingDecisions: null })
    ).toBe("working");
  });

  it("a failed proposals read on an idle session reads unmeasured, not done", () => {
    expect(
      stateOf({ status: "paused", owedFromYou: 0, pendingDecisions: null })
    ).toBe("paused");
    expect(
      stateOf({ status: "closed", owedFromYou: 0, pendingDecisions: null })
    ).toBe("done");
  });

  it("failed outranks terminal although failed is a terminal status", () => {
    expect(stateOf({ status: "failed", owedFromYou: 3 })).toBe("failed");
  });

  it("closed and cancelled are done even with work owed", () => {
    expect(stateOf({ status: "closed", owedFromYou: 2 })).toBe("done");
    expect(stateOf({ status: "cancelled", owedFromYou: 0 })).toBe("done");
  });

  it("scheduled and paused come from the lifecycle, with no invented cadence", () => {
    const scheduled = sessionUnitInput({ status: "scheduled", owedFromYou: 0 });
    expect(scheduled.schedule).toEqual({ cron: "", enabled: true });
    expect(resolveUnitState(scheduled).state).toBe("scheduled");
    expect(stateOf({ status: "paused", owedFromYou: 0 })).toBe("paused");
  });

  it("a blocked session waits on another, not on you", () => {
    expect(
      stateOf({ status: "active", owedFromYou: 0, blockedBy: "Write the spec" })
    ).toBe("blocked");
  });

  it("a null owed read on an active session still reads working", () => {
    expect(stateOf({ status: "active", owedFromYou: null })).toBe("working");
  });
});

describe("projectAggregateInput — a project over its sessions", () => {
  const agg = (
    sessions: Array<{ status: string; nextMoveActor: "user" | "ai" | "none" }>,
    unreadable = false
  ) => resolveUnitState(projectAggregateInput({ sessions, unreadable })).state;

  it("one session needing you outranks every other session being closed", () => {
    // Rules out setting terminal and owedFromYou together (terminal wins there).
    expect(
      agg([
        { status: "closed", nextMoveActor: "none" },
        { status: "closed", nextMoveActor: "user" },
      ])
    ).toBe("needs_you");
  });

  it("all sessions terminal is done", () => {
    expect(
      agg([
        { status: "closed", nextMoveActor: "none" },
        { status: "cancelled", nextMoveActor: "none" },
      ])
    ).toBe("done");
  });

  it("no sessions is not_started, and a failed read is unmeasured", () => {
    expect(agg([])).toBe("not_started");
    expect(agg([], true)).toBe("unmeasured");
  });

  it("an open session not waiting on you reads working", () => {
    expect(agg([{ status: "paused", nextMoveActor: "ai" }])).toBe("working");
  });
});

describe("sessionRowInput — one row of a project", () => {
  it("a closed row with a still-owed slot is done, not needs_you", () => {
    // Rules out reusing the aggregate verbatim for a single row.
    expect(
      resolveUnitState(
        sessionRowInput({ status: "closed", nextMoveActor: "user" })
      ).state
    ).toBe("done");
  });

  it("an open row whose next move is yours needs you", () => {
    expect(
      resolveUnitState(
        sessionRowInput({ status: "active", nextMoveActor: "user" })
      ).state
    ).toBe("needs_you");
  });
});
