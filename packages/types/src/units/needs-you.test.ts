import { describe, it, expect } from "vitest";
import {
  withProjectNeedsYouCount,
  needsYouReason,
  needsYouItems,
  needsYouTotal,
  sessionNeedsYou,
  tallyNeedsYou,
  waitsOnYouAtTerminal,
  type NeedsYouFacts,
} from "./needs-you.js";
import { projectAggregateInput } from "./session.js";
import { resolveUnitState } from "./state.js";

/**
 * Each row names the rule it rules OUT. The discriminating inputs are where the
 * four old derivations disagreed: a finished session awaiting review (owed +
 * pending rules said "not you"), an agent draft with work on it (the work map
 * said "you"), a closed session still owing a slot.
 */
const calm: NeedsYouFacts = { owedFromYou: 0, pendingDecisions: 0 };

describe("needsYouReason — the one rule", () => {
  it("counts the three populations", () => {
    expect(needsYouReason({ ...calm, owedFromYou: 2 })).toBe("owed");
    expect(needsYouReason({ ...calm, pendingDecisions: 1 })).toBe("decision");
    // Rules out the owed+pending-only rule (`sessionUnitInput`), which read a
    // finished session awaiting acceptance as "working".
    expect(needsYouReason({ ...calm, awaitingReview: true })).toBe("review");
  });

  it("an agent draft never needs you, whatever it carries", () => {
    // Rules out the work map's `drafted OR owner === you`.
    expect(
      needsYouReason({
        owedFromYou: 3,
        pendingDecisions: 2,
        awaitingReview: true,
        draft: true,
      })
    ).toBeNull();
  });

  it("nothing owed, pending or awaiting review is not yours", () => {
    expect(sessionNeedsYou(calm)).toBe(false);
    expect(sessionNeedsYou({ owedFromYou: 0 })).toBe(false);
  });

  it("the reasons are exclusive, owed first", () => {
    expect(
      needsYouReason({
        owedFromYou: 1,
        pendingDecisions: 1,
        awaitingReview: true,
      })
    ).toBe("owed");
  });

  it("a failed read is not a claim that you are needed", () => {
    expect(sessionNeedsYou({ owedFromYou: null, pendingDecisions: null })).toBe(
      false
    );
  });
});

describe("tallyNeedsYou — the parts and the one sum", () => {
  const rows: NeedsYouFacts[] = [
    { owedFromYou: 2, pendingDecisions: 0 }, // owed ×2
    { owedFromYou: 0, pendingDecisions: 3 }, // decisions ×3
    { owedFromYou: 0, pendingDecisions: 0, awaitingReview: true }, // review ×1
    { owedFromYou: 0, pendingDecisions: 0 }, // not yours
    // A draft with everything on it contributes NOTHING.
    { owedFromYou: 5, pendingDecisions: 5, awaitingReview: true, draft: true },
  ];

  it("counts items per population and sessions once each; drafts don't count", () => {
    expect(tallyNeedsYou(rows)).toEqual({
      owed: 2,
      decisions: 3,
      review: 1,
      permission: 0,
      sessions: 3,
      total: 6,
      unreadable: false,
    });
  });

  it("total is the one sum of the parts", () => {
    expect(needsYouTotal({ owed: 2, decisions: 3, review: 1 })).toBe(6);
  });

  it("a failed read marks the tally unreadable rather than zero", () => {
    expect(
      tallyNeedsYou([{ owedFromYou: null, pendingDecisions: 0 }]).unreadable
    ).toBe(true);
    expect(
      tallyNeedsYou([{ owedFromYou: 0, pendingDecisions: null }]).unreadable
    ).toBe(true);
  });
});

describe("projectAggregateInput — re-based on the rule", () => {
  const state = (
    sessions: Parameters<typeof projectAggregateInput>[0]["sessions"]
  ) =>
    resolveUnitState(projectAggregateInput({ sessions, unreadable: false }))
      .state;

  it("a draft whose pod actor says 'user' does not make the project need you", () => {
    // The discriminating row: the legacy actor rule says needs_you; the rule,
    // fed `unitFacts`, excludes the draft.
    expect(
      state([
        {
          status: "active",
          nextMoveActor: "user",
          unitFacts: { owedFromYou: 0, pendingDecisions: 2, draft: true },
        },
      ])
    ).toBe("working");
  });

  it("a finished session awaiting review makes the project need you", () => {
    expect(
      state([
        {
          status: "active",
          unitFacts: {
            owedFromYou: 0,
            pendingDecisions: 0,
            awaitingReview: true,
          },
        },
      ])
    ).toBe("needs_you");
  });

  it("without unitFacts the legacy actor still answers (callers not yet migrated)", () => {
    expect(state([{ status: "active", nextMoveActor: "user" }])).toBe(
      "needs_you"
    );
  });
});

describe("withProjectNeedsYouCount — the header's ONE state mark", () => {
  it("a positive count the rows cannot see reads needs-you", () => {
    const out = withProjectNeedsYouCount({ owedFromYou: 0, progress: 0.4 }, 3);
    expect(out).toEqual({ owedFromYou: 3, progress: 0.4 });
  });
  it("rows that already say needs-you are kept as they are", () => {
    const rows = { owedFromYou: 2, progress: null };
    expect(withProjectNeedsYouCount(rows, 36)).toBe(rows);
  });
  it("a zero or unmeasured count changes nothing", () => {
    const rows = { owedFromYou: 0, progress: 0.5 };
    expect(withProjectNeedsYouCount(rows, 0)).toBe(rows);
    expect(withProjectNeedsYouCount(rows, null)).toBe(rows);
  });
});

describe("needsYouItems — the per-row number a person glyph carries", () => {
  it("counts ITEMS the way tallyNeedsYou does, so a row and its tally can never disagree", () => {
    const rows: NeedsYouFacts[] = [
      { owedFromYou: 2, pendingDecisions: 1 },
      // Review counts only when it IS the reason — rules out the Zoom card's
      // old hand sum, which added `awaitingReview` beside owed items (3, not 2).
      { owedFromYou: 2, pendingDecisions: 0, awaitingReview: true },
      { owedFromYou: 0, pendingDecisions: 0, awaitingReview: true },
      // A draft contributes nothing — rules out the hand sum that ignored drafts.
      { owedFromYou: 4, pendingDecisions: 0, draft: true },
    ];
    expect(rows.map(needsYouItems)).toEqual([3, 2, 1, 0]);
    const sum = rows.reduce((n, row) => n + (needsYouItems(row) ?? 0), 0);
    expect(sum).toBe(tallyNeedsYou(rows).total);
  });

  it("a failed part is null, never folded into zero", () => {
    // Rules out `pendingDecisions ?? 0` on a failed read.
    expect(
      needsYouItems({ owedFromYou: 1, pendingDecisions: null })
    ).toBeNull();
    expect(needsYouItems({ owedFromYou: null })).toBeNull();
    expect(needsYouItems(null)).toBeNull();
    // `undefined` = not read: no claim, so it adds nothing.
    expect(needsYouItems({ owedFromYou: 1 })).toBe(1);
  });
});

describe("the terminal wait — an agent stopped on the person (D-R1, review M1)", () => {
  const waiting = { status: "active", runnerState: "needs_permission" };

  it("a permission dialog or a question at the terminal needs you; work, rest and an ended session do not", () => {
    expect(needsYouReason({ ...calm, runnerWait: waiting })).toBe("permission");
    expect(
      needsYouReason({
        ...calm,
        runnerWait: { status: "active", runnerState: "needs_answer" },
      })
    ).toBe("permission");
    for (const runnerState of ["busy", "idle", "ended", null]) {
      expect(
        needsYouReason({
          ...calm,
          runnerWait: { status: "active", runnerState },
        })
      ).toBeNull();
    }
    // Rules out a rule that reads the runner word and not the session.
    expect(
      needsYouReason({
        ...calm,
        runnerWait: { status: "closed", runnerState: "needs_permission" },
      })
    ).toBeNull();
  });

  it("an agent's own draft still needs you for its dialog (one item), never for anything else", () => {
    const draft: NeedsYouFacts = {
      owedFromYou: 3,
      pendingDecisions: 2,
      awaitingReview: true,
      draft: true,
      runnerWait: waiting,
    };
    expect(needsYouReason(draft)).toBe("permission");
    expect(needsYouItems(draft)).toBe(1);
  });

  it("ONE item beside what the session owes, as the pod's union counts it, and the other reasons first", () => {
    const owing: NeedsYouFacts = {
      owedFromYou: 2,
      pendingDecisions: 0,
      runnerWait: waiting,
    };
    expect(needsYouReason(owing)).toBe("owed");
    expect(needsYouItems(owing)).toBe(3);
    // Review stays review: the review scan (`needsYouReason === "review"`)
    // keeps a finished session whose agent also waits.
    const finished: NeedsYouFacts = {
      ...calm,
      awaitingReview: true,
      runnerWait: waiting,
    };
    expect(needsYouReason(finished)).toBe("review");
    expect(needsYouItems(finished)).toBe(2);
  });

  it("the row and its tally agree, a draft's dialog included", () => {
    const rows: NeedsYouFacts[] = [
      { ...calm, runnerWait: waiting },
      { owedFromYou: 1, pendingDecisions: 0, runnerWait: waiting },
      { ...calm, draft: true, runnerWait: waiting },
      { ...calm, runnerWait: { status: "active", runnerState: "busy" } },
    ];
    const tally = tallyNeedsYou(rows);
    expect(tally).toMatchObject({ owed: 1, permission: 3, sessions: 3 });
    expect(tally.total).toBe(
      rows.reduce((n, row) => n + (needsYouItems(row) ?? 0), 0)
    );
  });

  it("a FAILED runner read is unknown, never 'nothing waits'; an unread one is no claim", () => {
    expect(needsYouItems({ ...calm, runnerWait: null })).toBeNull();
    expect(tallyNeedsYou([{ ...calm, runnerWait: null }]).unreadable).toBe(
      true
    );
    expect(needsYouItems({ ...calm })).toBe(0);
    expect(waitsOnYouAtTerminal(undefined)).toBe(false);
  });
});
