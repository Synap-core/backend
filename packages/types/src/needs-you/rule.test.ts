/**
 * THE needs-you rule (decision E). One `describe` per fold; each test pairs
 * the row that lands in the fold with the row one fact away that does NOT,
 * so a rule that ignores the clause fails here (negative control: the rule
 * reverted to "every owed slot / pending proposal needs you" turns every
 * test red).
 *
 * The census block replays the shape of the 2026-10-26 count (needs-truth
 * §1): 92 owed asks + 22 pending proposals, 7 of which really needed the
 * founder. The real rows are not reproducible offline; the classes are.
 */
import { describe, expect, it } from "vitest";
import {
  classifyOwedAsk,
  classifyPendingProposal,
  foldNeedsYouCounts,
  isNeedsYou,
  needsYouHasRealAsker,
  needsYouSessionClass,
  type NeedsYouProposalFacts,
  type NeedsYouSessionFacts,
  type NeedsYouSlotFacts,
} from "./rule";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const AGENT = "agent-user-1";

/** A live session: an agent posted an hour ago, nothing running. */
const live: NeedsYouSessionFacts = {
  status: "active",
  turnInFlight: false,
  lastAgentActivityAt: ago(3_600_000),
  startedAt: ago(3 * DAY),
};

/** A fresh agent ask on a live session — the baseline that needs you. */
const ask: NeedsYouSlotFacts = {
  owner: "human",
  owedSince: ago(DAY),
  askedBy: AGENT,
  ask: { mode: "choose", options: [{ label: "A" }, { label: "B" }] },
};

describe("the headline: a real, fresh ask on live work", () => {
  it("needs you", () => {
    expect(classifyOwedAsk(ask, live, NOW)).toBe("needs_you");
    expect(isNeedsYou({ needsYouClass: "needs_you" })).toBe(true);
  });

  it("a slot nobody owes is in no list at all", () => {
    expect(classifyOwedAsk({ ...ask, status: "done" }, live, NOW)).toBeNull();
    expect(classifyOwedAsk({ ...ask, retiredAt: ago(1) }, live, NOW)).toBeNull();
    expect(classifyOwedAsk({ ...ask, optional: true }, live, NOW)).toBeNull();
    expect(classifyOwedAsk({ ...ask, owner: "agent" }, live, NOW)).toBeNull();
  });
});

describe("from_system: no real asker", () => {
  it.each([
    ["a criterion escalation", { criterionKey: "c1", askedBy: undefined }],
    ["a missing param", { paramName: "target", askedBy: undefined }],
    [
      "a run's 'keep going', even with the run's agent stamped",
      { askCause: { kind: "run", ref: { kind: "run", id: "r" } } },
    ],
    [
      "a decision ask no agent filed",
      { askCause: { kind: "decision" }, askedBy: undefined },
    ],
  ])("%s", (_name, patch) => {
    expect(classifyOwedAsk({ ...ask, ...patch }, live, NOW)).toBe(
      "from_system"
    );
  });

  it("an agent's decision ask, a gate and an external approval are real", () => {
    expect(
      classifyOwedAsk({ ...ask, askCause: { kind: "decision" } }, live, NOW)
    ).toBe("needs_you");
    expect(
      classifyOwedAsk(
        { ...ask, askedBy: undefined, askCause: { kind: "gate" } },
        live,
        NOW
      )
    ).toBe("needs_you");
    expect(
      classifyOwedAsk(
        { ...ask, askCause: { kind: "external_approval" } },
        live,
        NOW
      )
    ).toBe("needs_you");
  });

  it("a slot from before the stamps reads as asked; a cause with no kind names none", () => {
    expect(needsYouHasRealAsker({ owner: "human" })).toBe(true);
    expect(needsYouHasRealAsker({ owner: "human", askCause: {} })).toBe(true);
    expect(
      needsYouHasRealAsker({ owner: "human", askCause: { kind: "run" } })
    ).toBe(false);
    // An empty asker is nobody: the decision stays the system's.
    expect(
      needsYouHasRealAsker({ askCause: { kind: "decision" }, askedBy: "" })
    ).toBe(false);
  });

  it("outranks stopped (the census precedence: machine before stopped)", () => {
    const stopped = { ...live, lastAgentActivityAt: ago(30 * DAY), startedAt: ago(40 * DAY) };
    expect(
      classifyOwedAsk({ ...ask, criterionKey: "c" , askedBy: undefined }, stopped, NOW)
    ).toBe("from_system");
  });
});

describe("stopped: no agent moved the work for 7 days, or it ended", () => {
  it("no agent evidence for 7 days", () => {
    const quiet = { ...live, lastAgentActivityAt: ago(8 * DAY), startedAt: ago(20 * DAY) };
    expect(classifyOwedAsk(ask, quiet, NOW)).toBe("stopped");
    const recent = { ...quiet, lastAgentActivityAt: ago(6 * DAY) };
    expect(classifyOwedAsk(ask, recent, NOW)).toBe("needs_you");
  });

  it("a session that ended keeps its owed slot, in Stopped", () => {
    for (const status of ["closed", "failed", "cancelled"]) {
      expect(classifyOwedAsk(ask, { ...live, status }, NOW)).toBe("stopped");
    }
    for (const status of ["active", "paused", "stale"]) {
      expect(classifyOwedAsk(ask, { ...live, status }, NOW)).toBe("needs_you");
    }
  });

  it("the start is evidence: a new session no agent touched yet is live", () => {
    const fresh = { ...live, lastAgentActivityAt: null, startedAt: ago(DAY) };
    expect(needsYouSessionClass(fresh, NOW)).toBe("live");
    const never = { ...live, lastAgentActivityAt: null, startedAt: ago(9 * DAY) };
    expect(needsYouSessionClass(never, NOW)).toBe("stopped");
    expect(
      needsYouSessionClass(
        { ...live, lastAgentActivityAt: null, startedAt: null },
        NOW
      )
    ).toBe("stopped");
  });

  it("outranks working: an agent turn on an ended session is still stopped", () => {
    expect(
      classifyOwedAsk(ask, { ...live, status: "closed", turnInFlight: true }, NOW)
    ).toBe("stopped");
  });
});

describe("working: an agent is on it right now", () => {
  it("a turn in flight", () => {
    expect(classifyOwedAsk(ask, { ...live, turnInFlight: true }, NOW)).toBe(
      "working"
    );
  });

  it("agent evidence inside the working window, and not just outside it", () => {
    expect(
      classifyOwedAsk(ask, { ...live, lastAgentActivityAt: ago(60_000) }, NOW)
    ).toBe("working");
    expect(
      classifyOwedAsk(ask, { ...live, lastAgentActivityAt: ago(6 * 60_000) }, NOW)
    ).toBe("needs_you");
  });

  it("the start is not the agent working", () => {
    expect(
      classifyOwedAsk(
        ask,
        { ...live, lastAgentActivityAt: null, startedAt: ago(60_000) },
        NOW
      )
    ).toBe("needs_you");
  });
});

describe("review_later: a real ask owed more than 7 days", () => {
  it("ages out of the headline", () => {
    expect(classifyOwedAsk({ ...ask, owedSince: ago(8 * DAY) }, live, NOW)).toBe(
      "review_later"
    );
    expect(classifyOwedAsk({ ...ask, owedSince: ago(6 * DAY) }, live, NOW)).toBe(
      "needs_you"
    );
  });

  it.each([
    ["stakes: commitment", { ask: { mode: "confirm", stakes: "commitment" } }],
    [
      "a secret provide",
      { ask: { mode: "provide", provide: { kind: "secret", name: "KEY" } } },
    ],
    ["a gate", { askCause: { kind: "gate" } }],
    ["a relay waiting for the tap", { pendingRelay: { text: "yes" } }],
  ])("a commitment never ages: %s", (_name, patch) => {
    expect(
      classifyOwedAsk({ ...ask, owedSince: ago(30 * DAY), ...patch }, live, NOW)
    ).toBe("needs_you");
  });

  it("an unreadable stamp never ages (fails toward keeping)", () => {
    for (const owedSince of ["0000-00-00", "2026-01-01", "yesterday", 5, null]) {
      expect(classifyOwedAsk({ ...ask, owedSince }, live, NOW)).toBe(
        "needs_you"
      );
    }
  });

  it("a malformed provide is not a commitment and does not throw", () => {
    expect(
      classifyOwedAsk(
        { ...ask, owedSince: ago(8 * DAY), ask: { mode: "provide" } },
        live,
        NOW
      )
    ).toBe("review_later");
  });
});

describe("proposals: needs you only when something waits on it", () => {
  const base: NeedsYouProposalFacts = {
    status: "pending",
    createdAt: ago(DAY),
    waits: { waits: true, reason: "owed_slot" },
    sessionId: "s1",
    sessionStatus: "active",
  };

  it("a waited-on proposal on open work needs you", () => {
    expect(classifyPendingProposal(base, NOW)).toBe("needs_you");
  });

  it("nothing waits ⇒ a change to review (bookkeeping)", () => {
    expect(
      classifyPendingProposal({ ...base, waits: { waits: false } }, NOW)
    ).toBe("changes_to_review");
  });

  it("its session ended ⇒ a change to review; unreadable or none reads open", () => {
    expect(
      classifyPendingProposal({ ...base, sessionStatus: "closed" }, NOW)
    ).toBe("changes_to_review");
    expect(classifyPendingProposal({ ...base, sessionStatus: null }, NOW)).toBe(
      "needs_you"
    );
    expect(
      classifyPendingProposal(
        { ...base, sessionId: null, sessionStatus: null },
        NOW
      )
    ).toBe("needs_you");
  });

  it("a wait over 7 days goes to Review later; a gate never ages", () => {
    const old = { ...base, createdAt: ago(8 * DAY) };
    expect(classifyPendingProposal(old, NOW)).toBe("review_later");
    expect(
      classifyPendingProposal(
        { ...old, waits: { waits: true, reason: "gate" } },
        NOW
      )
    ).toBe("needs_you");
  });

  it("a decided proposal is in no list", () => {
    expect(
      classifyPendingProposal({ ...base, status: "approved" }, NOW)
    ).toBeNull();
  });
});

describe("the census shape (needs-truth §6): 114 claims, 7 real", () => {
  const stoppedSession = {
    ...live,
    lastAgentActivityAt: ago(12 * DAY),
    startedAt: ago(14 * DAY),
  };
  const working = { ...live, turnInFlight: true };

  it("folds the 2026-10-26 classes the way the plan says", () => {
    const slots: Array<{ slot: NeedsYouSlotFacts; s: NeedsYouSessionFacts; id: string }> = [];
    // (a) 6 real asks on 3 live sessions.
    for (let i = 0; i < 6; i++) slots.push({ slot: ask, s: live, id: `a${i % 3}` });
    // (b) 2 asks while the agent works.
    for (let i = 0; i < 2; i++) slots.push({ slot: ask, s: working, id: `b${i}` });
    // (c) 25 asks + (g) 5 chores on ~22 stopped sessions.
    for (let i = 0; i < 30; i++)
      slots.push({ slot: { ...ask, owedSince: ago(13 * DAY) }, s: stoppedSession, id: `c${i % 22}` });
    // (e) 22 machine-made: criterion, param, run, reactor decisions.
    const machine: NeedsYouSlotFacts[] = [
      { owner: "human", criterionKey: "k" },
      { owner: "human", paramName: "p" },
      { owner: "human", askCause: { kind: "run" }, askedBy: AGENT },
      { owner: "human", askCause: { kind: "decision" } },
    ];
    for (let i = 0; i < 22; i++)
      slots.push({ slot: machine[i % machine.length]!, s: live, id: `e${i}` });
    const proposals: NeedsYouProposalFacts[] = [
      // (a) the deploy approval: a gate.
      { status: "pending", createdAt: ago(DAY), waits: { waits: true, reason: "gate" }, sessionId: "d", sessionStatus: "active" },
      // (f) 12 bookkeeping, (c) 5 probe leftovers on a closed session, (d) 4 superseded.
      ...Array.from({ length: 12 }, () => ({ status: "pending", createdAt: ago(10 * DAY), waits: { waits: false }, sessionId: null, sessionStatus: null })),
      ...Array.from({ length: 5 }, () => ({ status: "pending", createdAt: ago(4 * DAY), waits: { waits: true, reason: "owed_slot" as const }, sessionId: "probe", sessionStatus: "closed" })),
      ...Array.from({ length: 4 }, () => ({ status: "pending", createdAt: ago(5 * DAY), waits: { waits: false }, sessionId: "x", sessionStatus: "active" })),
    ];
    const rows = [
      ...slots.map(({ slot, s, id }) => ({
        needsYouClass: classifyOwedAsk(slot, s, NOW)!,
        sessionId: id,
      })),
      ...proposals.map((p) => ({
        needsYouClass: classifyPendingProposal(p, NOW)!,
        sessionId: p.sessionId,
      })),
    ];
    expect(rows).toHaveLength(60 + 22);
    expect(foldNeedsYouCounts(rows)).toEqual({
      needsYou: 7,
      working: 2,
      stopped: 30,
      stoppedSessions: 22,
      reviewLater: 0,
      fromSystem: 22,
      changesToReview: 21,
    });
  });
});
