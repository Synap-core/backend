/**
 * THE NEXT MOVE of a thing and of a goal (`next-move.ts`), pure: an ended
 * subject has none; a pause is its hold's wait (the session's own rung 2c);
 * a wait is read by ball, yours first; a thing's next main-path step is "Your
 * move" when only a person may take it; a goal's claims wait on its judge, a
 * goal all met is the judge's to close, and a goal nobody works on asks to
 * start work.
 */
import { describe, expect, it } from "vitest";
import type {
  LifecycleOption,
  RecordedHold,
} from "@synap-core/types/lifecycle";
import type { WaitingOnMark } from "@synap-core/types/units";
import {
  deriveGoalNextMove,
  deriveThingNextMove,
  holdNextMove,
  leadWaitRef,
  type GoalNextMoveFacts,
  type GoalNextMoveInput,
  type ThingNextMoveInput,
} from "../next-move.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const ADA = "33333333-3333-4333-8333-333333333333";
const ME = "user-me";

const DEAL: { options: LifecycleOption[] } = {
  options: [
    { key: "draft", category: "open" },
    { key: "sent", category: "active", label: "Proposal sent" },
    { key: "signed", category: "active", label: "Signed", humanOnly: true },
    { key: "won", category: "done" },
    { key: "on_hold", category: "paused" },
    { key: "lost", category: "lost", humanOnly: true },
  ],
};

const thing = (over: Partial<ThingNextMoveInput>): ThingNextMoveInput => ({
  lifecycle: DEAL,
  status: "draft",
  category: "open",
  label: "Draft",
  waitingOn: [],
  hold: null,
  ...over,
});

const hold = (over: Partial<RecordedHold>): RecordedHold => ({
  on: "person",
  resumeTo: "sent",
  since: "2026-10-30T00:00:00.000Z",
  ...over,
});

const their: WaitingOnMark = {
  reason: "input",
  count: 1,
  refs: [
    { kind: "person", id: ADA, label: "Ada Lovelace", waitKind: "their_reply" },
  ],
};
const proposal: WaitingOnMark = {
  reason: "approval",
  count: 1,
  refs: [
    {
      kind: "proposal",
      id: P1,
      label: "Update the deal",
      waitKind: "approval",
    },
  ],
};
const slot: WaitingOnMark = {
  reason: "input",
  count: 1,
  refs: [{ kind: "slot", id: S1, label: "Which plan", waitKind: "decide" }],
};
const agentRun: WaitingOnMark = {
  reason: "another_work",
  count: 1,
  refs: [
    {
      kind: "session",
      id: S1,
      label: "Draft the brief",
      waitKind: "agent_work",
    },
  ],
};

describe("a thing's next move", () => {
  it("an ended thing has nothing to do", () => {
    for (const [status, category] of [
      ["won", "done"],
      ["lost", "lost"],
    ] as const) {
      expect(
        deriveThingNextMove(thing({ status, category, label: "Won" }))
      ).toMatchObject({ kind: "none", actor: "none" });
    }
  });

  it("a paused thing waits on what its hold names, as a paused session does", () => {
    const h = hold({ on: "person", reason: "Ada's go" });
    const ref = { kind: "person" as const, label: "Ada's go" };
    const move = deriveThingNextMove(
      thing({
        status: "on_hold",
        category: "paused",
        hold: { hold: h, ref },
        waitingOn: [their],
      })
    );
    expect(move).toEqual({
      ...holdNextMove(h, ref, "thing"),
      kind: "waiting_on_hold",
      actor: "none",
      label: "Waiting on Ada's go",
    });
    expect(move.reason).toMatch(/^This thing is paused: Ada's go\./);
    // The one rung, the session's words for a session.
    expect(holdNextMove(h, ref, "session").reason).toMatch(
      /^This session is paused/
    );
  });

  it("a pause with no hold is a bare pause; an unread hold is unknown", () => {
    expect(
      deriveThingNextMove(thing({ status: "on_hold", category: "paused" }))
    ).toMatchObject({
      kind: "waiting_on_hold",
      actor: "none",
      label: "Paused",
    });
    expect(
      deriveThingNextMove(
        thing({ status: "on_hold", category: "paused", hold: "unavailable" })
      )
    ).toMatchObject({ kind: "unknown" });
  });

  it("a thing waiting on a person names them; nobody here acts", () => {
    expect(
      deriveThingNextMove(
        thing({ status: "sent", category: "active", waitingOn: [their] })
      )
    ).toEqual({
      kind: "waiting_on",
      actor: "none",
      label: "Waiting on Ada Lovelace",
      reason: expect.stringMatching(/someone outside/),
      waitKind: "their_reply",
      entityId: ADA,
    });
  });

  it("your ball comes first: a proposal to review, a slot to provide", () => {
    expect(
      deriveThingNextMove(
        thing({ category: "active", waitingOn: [their, proposal] })
      )
    ).toMatchObject({
      kind: "pending_proposal",
      actor: "user",
      label: 'Review "Update the deal"',
      proposalId: P1,
    });
    expect(
      deriveThingNextMove(thing({ category: "active", waitingOn: [slot] }))
    ).toMatchObject({
      kind: "owed_slot",
      actor: "user",
      label: 'Provide "Which plan"',
      sessionId: S1,
      waitKind: "decide",
    });
  });

  it("a session an agent works on is the AI's move", () => {
    expect(
      deriveThingNextMove(thing({ category: "active", waitingOn: [agentRun] }))
    ).toMatchObject({
      kind: "waiting_on_session",
      actor: "ai",
      sessionId: S1,
      waitKind: "agent_work",
    });
  });

  it("a wait the reader may not see is still a wait; an unread one is unknown", () => {
    expect(
      deriveThingNextMove(
        thing({ waitingOn: [{ reason: "external", count: 2 }] })
      )
    ).toMatchObject({ kind: "waiting_on", actor: "none" });
    expect(
      deriveThingNextMove(thing({ waitingOn: "unavailable" }))
    ).toMatchObject({ kind: "unknown" });
  });

  it("its next main-path step: 'Your move' when only a person may take it", () => {
    expect(
      deriveThingNextMove(thing({ status: "sent", category: "active" }))
    ).toMatchObject({
      kind: "step",
      actor: "user",
      label: "Your move: Signed",
      to: "signed",
    });
    expect(deriveThingNextMove(thing({}))).toMatchObject({
      kind: "step",
      actor: "user",
      label: "Next: Proposal sent",
      to: "sent",
    });
  });

  it("a stuck thing's move says so", () => {
    const move = deriveThingNextMove(
      thing({ stuck: { afterDays: 3, forDays: 10 } })
    );
    expect(move.reason).toMatch(/10 days.*stuck after 3/);
  });

  it("a status its lifecycle does not declare is unknown; an empty path is none", () => {
    expect(
      deriveThingNextMove(thing({ status: "mystery", category: null }))
    ).toMatchObject({ kind: "unknown" });
    expect(
      deriveThingNextMove(
        thing({
          lifecycle: { options: [{ key: "only", category: "active" }] },
          status: "only",
          category: "active",
        })
      )
    ).toMatchObject({ kind: "none" });
  });
});

describe("leadWaitRef", () => {
  it("keeps the ref whose ball comes first, and can be narrowed to some balls", () => {
    expect(leadWaitRef([agentRun, their, slot])?.label).toBe("Which plan");
    expect(leadWaitRef([agentRun, their], ["me"])).toBeNull();
    expect(leadWaitRef([{ reason: "input", count: 1 }])).toBeNull();
  });
});

const facts = (over: Partial<GoalNextMoveFacts>): GoalNextMoveFacts => ({
  waitingOn: [],
  criteria: [],
  inReview: false,
  openRuns: 0,
  judge: { id: ME, name: "Me" },
  ...over,
});
const goal = (
  f: Partial<GoalNextMoveFacts>,
  over: Partial<GoalNextMoveInput> = {}
) =>
  deriveGoalNextMove({
    category: "active",
    label: "Active",
    hold: null,
    facts: facts(f),
    readerId: ME,
    ...over,
  });

describe("a goal's next move", () => {
  it("an ended goal has none; a paused one waits on its hold; unread facts are unknown", () => {
    expect(goal({}, { category: "done" })).toMatchObject({ kind: "none" });
    expect(
      goal(
        {},
        {
          category: "paused",
          hold: {
            hold: hold({ on: "date", until: { date: "2026-11-15" } }),
            ref: { kind: "thing", label: "2026-11-15" },
          },
        }
      )
    ).toMatchObject({
      kind: "waiting_on_hold",
      label: "Paused until 2026-11-15",
      reason: expect.stringMatching(/^This goal is paused/),
    });
    expect(
      deriveGoalNextMove({
        category: "active",
        label: null,
        hold: null,
        facts: "unavailable",
        readerId: ME,
      })
    ).toMatchObject({ kind: "unknown" });
  });

  it("a slot its runs owe you comes before its review", () => {
    expect(
      goal({
        waitingOn: [slot],
        inReview: true,
        criteria: [{ mark: "claimed" }],
      })
    ).toMatchObject({ kind: "owed_slot", actor: "user" });
  });

  it("a goal in review is its judge's: yours when you judge it", () => {
    const criteria = [
      { mark: "claimed" as const },
      { mark: "met" as const },
      { required: false, mark: "not_started" as const },
    ];
    expect(goal({ inReview: true, criteria })).toMatchObject({
      kind: "judge_review",
      actor: "user",
      label: "Judge 1 claimed criterion",
    });
    expect(
      goal({
        inReview: true,
        criteria,
        judge: { id: "user-bea", name: "Bea" },
      })
    ).toMatchObject({
      kind: "judge_review",
      actor: "none",
      label: "Waiting on Bea to judge 1 claimed criterion",
    });
  });

  it("every required criterion met: the judge closes it", () => {
    const criteria = [
      { mark: "met" as const },
      { required: false, mark: "not_met" as const },
    ];
    expect(goal({ criteria, openRuns: 1 })).toMatchObject({
      kind: "ready_to_close",
      actor: "user",
      label: "Close the goal",
    });
    expect(
      goal({ criteria, judge: { id: "user-bea", name: null } })
    ).toMatchObject({
      kind: "ready_to_close",
      actor: "none",
      label: "Waiting on its judge to close it",
    });
  });

  it("another's wait follows; an agent's run is the AI's move", () => {
    expect(goal({ waitingOn: [agentRun], openRuns: 1 })).toMatchObject({
      kind: "waiting_on_session",
      actor: "ai",
      sessionId: S1,
    });
  });

  it("no open session: start work on it; else its work is under way", () => {
    expect(goal({})).toMatchObject({
      kind: "start_work",
      actor: "user",
      label: "Start work on it",
    });
    expect(goal({ openRuns: 2 })).toMatchObject({
      kind: "waiting_on_session",
      actor: "none",
      label: "Work under way in 2 sessions",
    });
    // The tree's open sessions (the rollup) count those serving it too.
    expect(goal({}, { treeOpenSessions: 1 })).toMatchObject({
      kind: "waiting_on_session",
      label: "Work under way in 1 session",
    });
  });
});
