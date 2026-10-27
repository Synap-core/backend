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
    expect(
      classifyOwedAsk({ ...ask, retiredAt: ago(1) }, live, NOW)
    ).toBeNull();
    expect(classifyOwedAsk({ ...ask, optional: true }, live, NOW)).toBeNull();
    expect(classifyOwedAsk({ ...ask, owner: "agent" }, live, NOW)).toBeNull();
  });
});

describe("from_system: no real asker", () => {
  it("a decision ask no agent filed", () => {
    expect(
      classifyOwedAsk(
        { ...ask, askCause: { kind: "decision" }, askedBy: undefined },
        live,
        NOW
      )
    ).toBe("from_system");
  });

  // M3: each producer left after be#295 asks on someone's behalf. The slot
  // shapes are the producers' own (api `fileCriterionSlot`,
  // `askToContinueRun`, `paramOwedSlots`); a rule that sends a cause to the
  // system fold turns its row red.
  it.each([
    [
      "evaluate_session's criterion escalation (fileCriterionSlot)",
      {
        owner: "human",
        kind: "criterion",
        criterionKey: "tests-pass",
        blockedReason: "decision",
        owedSince: ago(DAY),
        ask: { mode: "choose", options: [{ label: "Met" }] },
      },
    ],
    [
      "an attended run's 'keep the run going' (run-turn-end)",
      {
        owner: "human",
        blockedReason: "decision",
        owedSince: ago(DAY),
        askedBy: AGENT,
        askCause: { kind: "run", ref: { kind: "run", id: "r" } },
        ask: { mode: "confirm" },
      },
    ],
    [
      "the person's own run missing a param (paramOwedSlots)",
      {
        owner: "human",
        kind: "playbook_param",
        blockedReason: "decision",
        owedSince: ago(DAY),
        paramName: "target",
        ask: { mode: "choose", options: [{ label: "prod" }] },
      },
    ],
  ])("needs you: %s", (_name, slot) => {
    expect(classifyOwedAsk(slot, live, NOW)).toBe("needs_you");
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
    ).toBe(true);
    // An empty asker is nobody: the decision stays the system's.
    expect(
      needsYouHasRealAsker({ askCause: { kind: "decision" }, askedBy: "" })
    ).toBe(false);
  });

  it("outranks stopped (the census precedence: machine before stopped)", () => {
    const stopped = {
      ...live,
      lastAgentActivityAt: ago(30 * DAY),
      startedAt: ago(40 * DAY),
    };
    expect(
      classifyOwedAsk(
        { ...ask, askCause: { kind: "decision" }, askedBy: undefined },
        stopped,
        NOW
      )
    ).toBe("from_system");
  });
});

describe("stopped: the agent's question on work no agent moved for 7 days, or that ended", () => {
  it("no agent evidence for 7 days", () => {
    const quiet = {
      ...live,
      lastAgentActivityAt: ago(8 * DAY),
      startedAt: ago(20 * DAY),
    };
    expect(classifyOwedAsk(ask, quiet, NOW)).toBe("stopped");
    const recent = { ...quiet, lastAgentActivityAt: ago(6 * DAY) };
    expect(classifyOwedAsk(ask, recent, NOW)).toBe("needs_you");
  });

  it("an ended session's question is Stopped; only the terminal set ended", () => {
    for (const status of ["closed", "failed", "cancelled"]) {
      expect(classifyOwedAsk(ask, { ...live, status }, NOW)).toBe("stopped");
    }
    // S4: forming and scheduled have not ended (nor has an unknown status).
    for (const status of [
      "active",
      "paused",
      "stale",
      "forming",
      "scheduled",
      "weird",
    ]) {
      expect(classifyOwedAsk(ask, { ...live, status }, NOW)).toBe("needs_you");
    }
  });

  // M4: closing keeps a person deliverable owed, and "Resume or close" can
  // never clear it: it is the person's to do, so it stays in the headline.
  describe("a person deliverable is never Stopped", () => {
    const closed = { ...live, status: "closed" };
    const quiet = {
      ...live,
      lastAgentActivityAt: ago(8 * DAY),
      startedAt: ago(20 * DAY),
    };
    it.each([
      ["an act", { ask: { mode: "act" } }],
      ["a provide", { ask: { mode: "provide", provide: { kind: "file" } } }],
      ["a form", { ask: { mode: "form" } }],
      ["plain work", { ask: undefined }],
      ["a criterion grade", { criterionKey: "k", ask: { mode: "choose" } }],
      ["a confirm the closing agent kept owed", { keptOwedAt: ago(DAY) }],
    ])("%s on a closed or a quiet session", (_name, patch) => {
      const slot = { ...ask, ...patch };
      expect(classifyOwedAsk(slot, closed, NOW)).toBe("needs_you");
      expect(classifyOwedAsk(slot, quiet, NOW)).toBe("needs_you");
      // The same slot, one fact away: the age clause still applies.
      expect(
        classifyOwedAsk({ ...slot, owedSince: ago(9 * DAY) }, closed, NOW)
      ).toBe("review_later");
    });

    it("while the agent's confirm and choose on it are Stopped", () => {
      for (const a of [{ mode: "confirm" }, ask.ask]) {
        expect(classifyOwedAsk({ ...ask, ask: a }, closed, NOW)).toBe(
          "stopped"
        );
        expect(classifyOwedAsk({ ...ask, ask: a }, quiet, NOW)).toBe("stopped");
      }
    });
  });

  it("the start is evidence: a new session no agent touched yet is live", () => {
    const fresh = { ...live, lastAgentActivityAt: null, startedAt: ago(DAY) };
    expect(needsYouSessionClass(fresh, NOW)).toBe("live");
    const never = {
      ...live,
      lastAgentActivityAt: null,
      startedAt: ago(9 * DAY),
    };
    expect(needsYouSessionClass(never, NOW)).toBe("stopped");
    // No readable clock at all (a legacy row): never called stopped.
    expect(
      needsYouSessionClass(
        { ...live, lastAgentActivityAt: null, startedAt: null },
        NOW
      )
    ).toBe("live");
  });

  it("outranks working: an agent turn on an ended session is still stopped", () => {
    expect(
      classifyOwedAsk(
        ask,
        { ...live, status: "closed", turnInFlight: true },
        NOW
      )
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
      classifyOwedAsk(
        ask,
        { ...live, lastAgentActivityAt: ago(6 * 60_000) },
        NOW
      )
    ).toBe("needs_you");
  });

  it("an agent that asked and stopped is not working: the asking is not work (E2)", () => {
    // The question was posted a minute ago; the agent's last WORK is 2 days old.
    const asked = {
      ...live,
      lastAgentActivityAt: ago(60_000),
      lastAgentWorkAt: ago(2 * DAY),
    };
    expect(classifyOwedAsk(ask, asked, NOW)).toBe("needs_you");
    // It kept working after asking: Working.
    expect(
      classifyOwedAsk(ask, { ...asked, lastAgentWorkAt: ago(60_000) }, NOW)
    ).toBe("working");
    // The asking still moved the session: not Stopped.
    expect(
      needsYouSessionClass(
        {
          ...live,
          startedAt: ago(20 * DAY),
          lastAgentActivityAt: ago(2 * DAY),
          lastAgentWorkAt: null,
        },
        NOW
      )
    ).toBe("live");
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
    expect(
      classifyOwedAsk({ ...ask, owedSince: ago(8 * DAY) }, live, NOW)
    ).toBe("review_later");
    expect(
      classifyOwedAsk({ ...ask, owedSince: ago(6 * DAY) }, live, NOW)
    ).toBe("needs_you");
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
    for (const owedSince of [
      "0000-00-00",
      "2026-01-01",
      "yesterday",
      5,
      null,
    ]) {
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
    // S4: forming / scheduled have not ended.
    for (const sessionStatus of ["forming", "scheduled", "stale"]) {
      expect(classifyPendingProposal({ ...base, sessionStatus }, NOW)).toBe(
        "needs_you"
      );
    }
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

  it("F2: it waits with a session an agent is working; a gate never does", () => {
    const working = { ...base, sessionClass: "working" as const };
    expect(classifyPendingProposal(working, NOW)).toBe("working");
    expect(
      classifyPendingProposal(
        { ...working, waits: { waits: true, reason: "gate" } },
        NOW
      )
    ).toBe("needs_you");
    for (const sessionClass of ["live", "stopped", null, undefined] as const) {
      expect(classifyPendingProposal({ ...base, sessionClass }, NOW)).toBe(
        "needs_you"
      );
    }
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
    const slots: Array<{
      slot: NeedsYouSlotFacts;
      s: NeedsYouSessionFacts;
      id: string;
    }> = [];
    // (a) 6 real asks on 3 live sessions.
    for (let i = 0; i < 6; i++)
      slots.push({ slot: ask, s: live, id: `a${i % 3}` });
    // (b) 2 asks while the agent works.
    for (let i = 0; i < 2; i++)
      slots.push({ slot: ask, s: working, id: `b${i}` });
    // (c) 25 agent questions on 22 stopped sessions.
    for (let i = 0; i < 25; i++)
      slots.push({
        slot: { ...ask, owedSince: ago(13 * DAY) },
        s: stoppedSession,
        id: `c${i % 22}`,
      });
    // (g) 5 founder chores there: still the founder's, but 13 days old.
    for (let i = 0; i < 5; i++)
      slots.push({
        slot: { ...ask, owedSince: ago(13 * DAY), ask: { mode: "act" } },
        s: stoppedSession,
        id: `c${i}`,
      });
    // (e) 22 machine-made: reactor decisions no agent filed (the criterion,
    // param and run producers that asked on nobody's behalf are gone, be#295).
    for (let i = 0; i < 22; i++)
      slots.push({
        slot: { owner: "human", askCause: { kind: "decision" } },
        s: live,
        id: `e${i}`,
      });
    const proposals: NeedsYouProposalFacts[] = [
      // (a) the deploy approval: a gate.
      {
        status: "pending",
        createdAt: ago(DAY),
        waits: { waits: true, reason: "gate" },
        sessionId: "d",
        sessionStatus: "active",
      },
      // (f) 12 bookkeeping, (c) 5 probe leftovers on a closed session, (d) 4 superseded.
      ...Array.from({ length: 12 }, () => ({
        status: "pending",
        createdAt: ago(10 * DAY),
        waits: { waits: false },
        sessionId: null,
        sessionStatus: null,
      })),
      ...Array.from({ length: 5 }, () => ({
        status: "pending",
        createdAt: ago(4 * DAY),
        waits: { waits: true, reason: "owed_slot" as const },
        sessionId: "probe",
        sessionStatus: "closed",
      })),
      ...Array.from({ length: 4 }, () => ({
        status: "pending",
        createdAt: ago(5 * DAY),
        waits: { waits: false },
        sessionId: "x",
        sessionStatus: "active",
      })),
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
      stopped: 25,
      stoppedSessions: 22,
      reviewLater: 5,
      fromSystem: 22,
      changesToReview: 21,
    });
  });
});

describe("fold words (vocabulary): one name and one hint per fold", () => {
  it("covers every fold, and an unknown one humanizes", async () => {
    const { resolveNeedsYouFoldLabel, resolveNeedsYouFoldHint } =
      await import("../vocabulary/index.js");
    const { NEEDS_YOU_FOLDS } = await import("./rule.js");
    for (const f of NEEDS_YOU_FOLDS) {
      expect(resolveNeedsYouFoldLabel(f)).not.toMatch(/_/);
      expect(resolveNeedsYouFoldHint(f)).toBeTruthy();
    }
    expect(resolveNeedsYouFoldLabel("stopped")).toBe("Stopped");
    expect(resolveNeedsYouFoldHint("brand_new")).toBeNull();
  });
});
