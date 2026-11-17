/**
 * nextStepsOf: each guard written out and run with its fix reverted
 * (negative control `negctl/feat/timeline-entry-module`).
 */
import { describe, expect, it } from "vitest";

import { NEXT_STEPS_CAP, nextStepsOf, type BlockerOf } from "./next-steps.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const verbs = (b: BlockerOf, now = NOW) =>
  nextStepsOf(b, { now }).map((s) => s.verb);

const batch = (over: Partial<Extract<BlockerOf, { kind: "batch" }>> = {}) =>
  ({
    kind: "batch",
    key: "batch:sends",
    proposalIds: ["p1", "p2", "p3"],
    count: 3,
    routine: false,
    ...over,
  }) as BlockerOf;
const ask = (blockedReason: string | null, over = {}) =>
  ({
    kind: "ask",
    key: "ask:s1:pick",
    sessionId: "s1",
    slotLabel: "Pick",
    blockedReason,
    ...over,
  }) as BlockerOf;
const wait = (
  waitKind: string,
  repeats: { count: number; medianMs: number } | null,
  over = {}
) =>
  ({
    kind: "wait",
    key: "wait:s1",
    sessionId: "s1",
    waitKind,
    refKey: "devbox:be-file",
    repeats,
    ...over,
  }) as BlockerOf;

describe("nextStepsOf: a batch of Requests", () => {
  it("offers a review with AI (uses AI, starts nothing itself) and deciding here", () => {
    const steps = nextStepsOf(batch(), { now: NOW });
    expect(steps.map((s) => s.verb)).toEqual(["review_with_ai", "decide_here"]);
    expect(steps[0]).toMatchObject({
      key: "batch:sends:review_with_ai",
      action: "review",
      usesAi: true,
      openJobId: null,
      door: {
        kind: "playbook",
        playbookKey: "review-request-batch",
        params: { proposalIds: ["p1", "p2", "p3"] },
      },
    });
    expect(steps[1]!.usesAi).toBe(false);
  });

  it("reviews once per batch per 24 h: inside the window the review is not offered", () => {
    const recent = batch({ aiReviewedAt: "2026-11-18T01:00:00Z" });
    expect(verbs(recent)).toEqual(["decide_here"]);
    const old = batch({ aiReviewedAt: "2026-11-17T11:59:00Z" });
    expect(verbs(old)).toEqual(["review_with_ai", "decide_here"]);
  });

  it("inside the window with a Job still open, the step opens that Job", () => {
    const [review] = nextStepsOf(
      batch({ aiReviewedAt: "2026-11-18T01:00:00Z", openJobId: "j9" }),
      { now: NOW }
    );
    expect(review).toMatchObject({ verb: "review_with_ai", openJobId: "j9" });
  });

  it("'always allow' only for a routine batch seen whole; a sample is never decided in bulk", () => {
    expect(verbs(batch({ routine: true }))).toEqual([
      "review_with_ai",
      "decide_here",
      "always_allow",
    ]);
    expect(verbs(batch({ routine: true, count: 12 }))).toEqual([
      "review_with_ai",
      "decide_here",
    ]);
    expect(verbs(batch({ routine: false }))).not.toContain("always_allow");
  });
});

describe("nextStepsOf: an ask on the person", () => {
  it("a decision or a physical step can be handed to an agent; always talk it through", () => {
    expect(verbs(ask("decision"))).toEqual(["hand_to_agent", "talk_it_through"]);
    expect(verbs(ask("physical"))).toEqual(["hand_to_agent", "talk_it_through"]);
    const [hand] = nextStepsOf(ask("decision"), { now: NOW });
    expect(hand!.door).toEqual({
      kind: "call",
      procedure: "focusSessions.delegateOutput",
      params: { sessionId: "s1", slotLabel: "Pick" },
    });
  });

  it("a missing capability, credential or permission offers a tool for agents, AI-run", () => {
    for (const reason of ["capability", "credential", "permission"]) {
      const steps = nextStepsOf(ask(reason), { now: NOW });
      expect(steps.map((s) => s.verb)).toEqual([
        "give_agents_a_tool",
        "talk_it_through",
      ]);
      expect(steps[0]).toMatchObject({ usesAi: true, action: "build" });
    }
  });

  it("an unsaid reason still offers to talk it through", () => {
    expect(verbs(ask(null))).toEqual(["talk_it_through"]);
  });
});

describe("nextStepsOf: a Job waiting", () => {
  const SLOW = { count: 4, medianMs: 60_000 };

  it("a slow, repeating machine wait offers to speed it up and to open what it waits on", () => {
    const b = wait("devbox_job", SLOW, {
      waitedOn: { kind: "pull_request", id: "o/r#7" },
    });
    expect(verbs(b)).toEqual(["speed_up", "open_waited_on"]);
  });

  it("not slow, or not read: no speed-up (an unread history is never folded into 'fast')", () => {
    expect(verbs(wait("devbox_job", { count: 1, medianMs: 60_000 }))).toEqual(
      []
    );
    expect(verbs(wait("devbox_job", null))).toEqual([]);
    expect(
      verbs(wait("devbox_job", { count: 1, medianMs: 31 * 60_000 }))
    ).toEqual(["speed_up"]);
  });

  it("the ball is the person's: nothing is offered", () => {
    expect(
      verbs(wait("approval", SLOW, { waitedOn: { kind: "proposal", id: "p" } }))
    ).toEqual([]);
  });

  it("an unknown wait kind offers nothing", () => {
    expect(verbs(wait("something_new", SLOW))).toEqual([]);
  });

  it("their move: a nudge opens the room, sent only by the person", () => {
    const [nudge] = nextStepsOf(wait("their_reply", null), { now: NOW });
    expect(nudge).toMatchObject({
      verb: "nudge",
      usesAi: false,
      door: { kind: "object", door: { kind: "session", id: "s1", view: "room" } },
    });
  });
});

describe("nextStepsOf: the guards that hold for every blocker", () => {
  it("no next steps on a next step (AI never asks AI)", () => {
    expect(verbs(batch({ fromNextStep: true }))).toEqual([]);
    expect(verbs(ask("decision", { fromNextStep: true }))).toEqual([]);
    expect(
      verbs(wait("devbox_job", { count: 9, medianMs: 1 }, { fromNextStep: true }))
    ).toEqual([]);
  });

  it("never more than the cap", () => {
    const most = batch({ routine: true });
    expect(nextStepsOf(most, { now: NOW }).length).toBeLessThanOrEqual(
      NEXT_STEPS_CAP
    );
    expect(NEXT_STEPS_CAP).toBe(3);
  });

  it("an offer is data: no step carries a started Job, and a Job-starting step is a playbook door", () => {
    const all = [
      ...nextStepsOf(batch({ routine: true }), { now: NOW }),
      ...nextStepsOf(ask("credential"), { now: NOW }),
    ];
    for (const s of all) {
      expect(s.door.kind).toMatch(/^(playbook|call|object|batch)$/);
      expect(s.openJobId).toBeNull();
    }
  });
});
