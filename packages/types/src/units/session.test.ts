import { describe, it, expect } from "vitest";
import { resolveUnitState } from "./state.js";
import {
  sessionUnitInput,
  projectAggregateInput,
  sessionRowInput,
  openBlockerTitle,
  pathRowNeedsYouItems,
  pathRowSessionFact,
  pathRowUnitView,
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

  it("closed and cancelled with nothing owed are done", () => {
    expect(stateOf({ status: "closed", owedFromYou: 0 })).toBe("done");
    expect(stateOf({ status: "cancelled", owedFromYou: 0 })).toBe("done");
  });

  it("a closed session that still owes you reads like its path row: needs you", () => {
    // Rules out `terminal` outranking owed (the header / relay hero said done
    // while Home and the path row said "needs you").
    expect(stateOf({ status: "closed", owedFromYou: 2 })).toBe("needs_you");
    expect(
      stateOf({ status: "cancelled", owedFromYou: 0, pendingDecisions: 1 })
    ).toBe("needs_review");
    // One state everywhere: the session-level door and the row door agree.
    for (const status of ["closed", "cancelled"]) {
      const view = resolveUnitState(
        sessionRowInput({ status, unitFacts: { owedFromYou: 2 } })
      );
      expect(stateOf({ status, owedFromYou: 2 })).toBe(view.state);
    }
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
  it("a closed row that still owes you NEEDS YOU — the needs-you rule, not the lifecycle, decides", () => {
    // Rules out "terminal first": the row read ✓ while needs-you.ts (and Home)
    // counted the same session as on you. The ONE row where the two rules
    // disagree is closed + owed.
    const closed = (unitFacts: {
      owedFromYou: number | null;
      pendingDecisions?: number | null;
      draft?: boolean;
    }) =>
      resolveUnitState(sessionRowInput({ status: "closed", unitFacts })).state;
    expect(closed({ owedFromYou: 1, pendingDecisions: 0 })).toBe("needs_you");
    expect(closed({ owedFromYou: 0, pendingDecisions: 2 })).toBe("needs_you");
    // Rules out "any owed count ⇒ you" on a draft, closed or not.
    expect(closed({ owedFromYou: 1, pendingDecisions: 0, draft: true })).toBe(
      "done"
    );
    // Nothing owed: a closed row is done (rules out "never done while facts exist").
    expect(closed({ owedFromYou: 0, pendingDecisions: 0 })).toBe("done");
    // The legacy actor agrees: the pod answers `user` for an owed slot on a
    // closed session, so the old-pod path reads the same.
    expect(
      resolveUnitState(
        sessionRowInput({ status: "closed", nextMoveActor: "user" })
      ).state
    ).toBe("needs_you");
  });

  it("an open row whose next move is yours needs you", () => {
    expect(
      resolveUnitState(
        sessionRowInput({ status: "active", nextMoveActor: "user" })
      ).state
    ).toBe("needs_you");
  });

  it("a row reads its own lifecycle — paused, scheduled and stale are not `working`", () => {
    // Rules out the aggregate's blanket "open ⇒ running" for ONE row: it drew a
    // paused or reaper-stale session as an agent at work.
    const stateOf = (status: string) =>
      resolveUnitState(sessionRowInput({ status, nextMoveActor: "none" }))
        .state;
    expect(stateOf("paused")).toBe("paused");
    expect(stateOf("scheduled")).toBe("scheduled");
    expect(stateOf("stale")).toBe("unmeasured");
    expect(stateOf("active")).toBe("working");
    // …and needing you still outranks a quiet lifecycle (a stale session that
    // owes the person is THEIR move — the work map's MUST 2.4).
    expect(
      resolveUnitState(
        sessionRowInput({
          status: "stale",
          unitFacts: { owedFromYou: 2, pendingDecisions: 0 },
        })
      ).state
    ).toBe("needs_you");
  });

  it("an open row waiting on another open session is blocked — and needing you still outranks it", () => {
    // Rules out the aggregate verbatim, which has no blocked arm: it read a
    // waiting row as `working` (the work map's `blocked` mark had no shared home).
    const row = (actor: "user" | "ai") =>
      resolveUnitState(
        sessionRowInput({
          status: "active",
          nextMoveActor: actor,
          blockedBy: "Build the import",
        })
      ).state;
    expect(row("ai")).toBe("blocked");
    expect(row("user")).toBe("needs_you");
    // A closed row is done, blocker or not.
    expect(
      resolveUnitState(sessionRowInput({ status: "closed", blockedBy: "x" }))
        .state
    ).toBe("done");
  });
});

describe("pathRowSessionFact — THE door every path surface reads a row through", () => {
  const edges = (...items: Array<{ title: string; status: string }>) => ({
    status: "ok" as const,
    items,
  });

  it("the blocker is the first OPEN one; a finished or unreadable blocker blocks nothing", () => {
    // Rules out "any blocked_by edge ⇒ blocked" (a finished blocker) and
    // "unreadable ⇒ blocked" (the chip says couldn't load; the mark never guesses).
    expect(
      openBlockerTitle(
        edges(
          { title: "Done one", status: "closed" },
          { title: "Spec", status: "active" }
        )
      )
    ).toBe("Spec");
    expect(openBlockerTitle(edges({ title: "x", status: "cancelled" }))).toBe(
      null
    );
    expect(openBlockerTitle({ status: "unavailable" })).toBeNull();
    expect(openBlockerTitle(null)).toBeNull();
  });

  it("an open row waiting on an open session reads blocked on every path surface", () => {
    // Rules out the track page / Relay reading, which never passed the blocker
    // and drew the same session `working`.
    const view = pathRowUnitView({
      status: "active",
      unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
      blockedBy: edges({ title: "Build the import", status: "active" }),
    });
    expect(view.state).toBe("blocked");
    expect(
      pathRowUnitView({
        status: "active",
        unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
        blockedBy: edges({ title: "Build the import", status: "closed" }),
      }).state
    ).toBe("working");
  });

  it("a triage draft never needs you, even when its unitFacts predate `draft`", () => {
    // Rules out trusting `unitFacts` alone: an older pod projects owed counts
    // without `draft`, and the map once read 8 "needs you" vs the sidebar's 5.
    const row = {
      status: "active",
      unitFacts: { owedFromYou: 2, pendingDecisions: 0 },
      triage: { pending: true },
    };
    expect(pathRowUnitView(row).state).not.toBe("needs_you");
    expect(pathRowSessionFact(row).unitFacts?.draft).toBe(true);
    // …and its count agrees with its mark: zero, not the two owed slots.
    expect(pathRowNeedsYouItems(row)).toBe(0);
    // …and on the legacy actor, which cannot see a draft at all.
    expect(
      pathRowUnitView({
        status: "active",
        nextMoveActor: "user",
        triage: { pending: true },
      }).state
    ).toBe("working");
  });

  it("the legacy actor is read only when unitFacts are absent", () => {
    expect(
      pathRowSessionFact({
        status: "active",
        unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
        nextMoveActor: "user",
      })
    ).toEqual({
      status: "active",
      unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
      blockedBy: null,
    });
    expect(
      pathRowUnitView({ status: "active", nextMoveActor: "user" }).state
    ).toBe("needs_you");
  });
});
