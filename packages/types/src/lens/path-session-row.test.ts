/**
 * A path session as THE lens row — one rule for the track page, the project
 * sidebar and Relay's path rows. Fixture rows where a naive rule disagrees:
 * a triage DRAFT that owes items (a naive "owes ⇒ blocking" says Blocking),
 * and a row waiting on an OPEN session (a naive "status active ⇒ happening").
 */
import { describe, expect, it } from "vitest";
import { resolveUnitState } from "../units/state.js";
import { lensRowOfPathSession, lensRowOfSession } from "./rows.js";

const facts = { owedFromYou: 2, pendingDecisions: 0 };

describe("lensRowOfPathSession", () => {
  it("a session that owes you is Blocking, opens the session, keeps its reason", () => {
    const row = lensRowOfPathSession({
      id: "s1",
      title: "Draft the brief",
      status: "active",
      unitFacts: facts,
      reason: "You · answer the brief",
    });
    expect(row.cls).toBe("blocking");
    expect(resolveUnitState(row.state).state).toBe("needs_you");
    expect(row.door).toEqual({ kind: "session", id: "s1" });
    expect(row.reason).toBe("You · answer the brief");
  });

  it("a triage draft never reads 'needs you' — the path-row door folds the draft", () => {
    const row = lensRowOfPathSession({
      id: "s2",
      title: "Agent draft",
      status: "active",
      unitFacts: facts,
      triage: { pending: true },
    });
    expect(row.cls).not.toBe("blocking");
    expect(resolveUnitState(row.state).state).not.toBe("needs_you");
  });

  it("a session waiting on an open session reads blocked, quiet ink", () => {
    const row = lensRowOfPathSession({
      id: "s3",
      title: "Ship it",
      status: "active",
      unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
      blockedBy: {
        status: "ok",
        items: [{ id: "s0", title: "Review", status: "active" }],
      } as never,
    });
    expect(resolveUnitState(row.state).state).toBe("blocked");
    expect(row.cls).toBe("happened");
  });

  it("an empty reason is no reason, never an empty chip", () => {
    const row = lensRowOfPathSession({
      id: "s4",
      title: "t",
      status: "completed",
      reason: "  ",
    });
    expect(row.reason).toBeNull();
    expect(row.source).toBeNull();
  });
});

describe("lensRowOfSession", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");

  it("owes you ⇒ Blocking; the age is when it last moved", () => {
    const row = lensRowOfSession({
      id: "s1",
      title: "Brief",
      status: "active",
      unitFacts: { owedFromYou: 1, pendingDecisions: 0 },
      startedAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-12T10:00:00Z",
      closedAt: "2026-10-11T00:00:00Z",
      now,
    });
    expect(row.cls).toBe("blocking");
    expect(row.occurredAt).toBe("2026-10-12T10:00:00.000Z");
    expect(row.door).toEqual({ kind: "session", id: "s1" });
  });

  it("a finished session's age is when it settled, not when it last moved", () => {
    const row = lensRowOfSession({
      id: "s2",
      title: "Done",
      status: "closed",
      updatedAt: "2026-10-12T10:00:00Z",
      closedAt: "2026-10-11T00:00:00Z",
    });
    expect(row.occurredAt).toBe("2026-10-11T00:00:00.000Z");
    expect(row.cls).toBe("happened");
  });

  it("the reason defaults to what blocks it; a caller's reason wins, an empty one is none", () => {
    expect(
      lensRowOfSession({ id: "a", title: "t", blockedBy: "Review" }).reason
    ).toBe("Blocked by Review");
    expect(
      lensRowOfSession({
        id: "a",
        title: "t",
        blockedBy: "Review",
        reason: "Drafted",
      }).reason
    ).toBe("Drafted");
    expect(
      lensRowOfSession({
        id: "a",
        title: "t",
        blockedBy: "Review",
        reason: null,
      }).reason
    ).toBeNull();
  });
});
