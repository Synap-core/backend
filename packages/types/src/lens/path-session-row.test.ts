/**
 * A path session as THE lens row — one rule for the track page, the project
 * sidebar and Relay's path rows. Fixture rows where a naive rule disagrees:
 * a triage DRAFT that owes items (a naive "owes ⇒ blocking" says Blocking),
 * and a row waiting on an OPEN session (a naive "status active ⇒ happening").
 */
import { describe, expect, it } from "vitest";
import { resolveUnitState } from "../units/state.js";
import { lensRowOfPathSession } from "./rows.js";

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
