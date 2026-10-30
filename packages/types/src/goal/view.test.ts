import { describe, expect, it } from "vitest";
import type { GoalCriterionView, TrackParticipant } from "../units/index.js";
import type { GoalLike } from "./model.js";
import {
  GOAL_VIEW_COPY,
  goalDropConditions,
  goalPeriod,
  goalViewFor,
} from "./view.js";

const OWNER = "u-owner";
const OTHER = "u-other";
const crit = (
  key: string,
  mark: GoalCriterionView["mark"]
): GoalCriterionView => ({
  key,
  statement: key,
  check: { kind: "human" },
  acceptance: null,
  mark,
  acceptanceState: null,
  meaning: "judged",
  currentValue: null,
  claim: null,
});
const owner: TrackParticipant = {
  id: "p1",
  principalKind: "person",
  principalId: OWNER,
  role: "owner",
  commitment: null,
  commitmentState: null,
  counterText: null,
  reportedReason: null,
  reportedAt: null,
  acknowledgedAt: null,
  decidedBy: OWNER,
  decidedAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-20T00:00:00.000Z",
  silentSince: null,
  displayName: "Camille Laurent",
};
const goal = (over: Partial<GoalLike> = {}): GoalLike => ({
  id: "g1",
  name: "Ship it",
  status: "active",
  verdict: null,
  verdictReason: null,
  direction: "Testers stop losing work.",
  endState: null,
  criteria: [crit("a", "claimed"), crit("b", "met")],
  dropConditions: [],
  workKind: "project",
  uncertainty: null,
  kindConfirmedBy: null,
  inReview: true,
  waitingOn: [],
  participants: [owner],
  ...over,
});
const me = { userId: OWNER, kind: "person" as const };

describe("goalViewFor — one view of a goal for desk and phone", () => {
  it("Done when never shows the purpose in place of an unsaid end state", () => {
    const v = goalViewFor(goal(), { viewer: me });
    expect(v.header.purpose).toBe("Testers stop losing work.");
    expect(v.doneWhen.endState).toBeNull();
    expect(
      goalViewFor(goal({ endState: " Beta in 20 hands " }), { viewer: me })
        .doneWhen.endState
    ).toBe("Beta in 20 hands");
  });

  it("a lasting goal invites criteria for its owner, explains for anyone else", () => {
    const lasting = goal({ criteria: [], inReview: false });
    expect(goalViewFor(lasting, { viewer: me }).doneWhen.lasting).toEqual({
      tone: "invite",
      title: GOAL_VIEW_COPY.lastingInvite,
      action: GOAL_VIEW_COPY.addCriteria,
    });
    expect(
      goalViewFor(lasting, { viewer: { userId: OTHER, kind: "person" } })
        .doneWhen.lasting?.tone
    ).toBe("explain");
    expect(goalViewFor(goal(), { viewer: me }).doneWhen.lasting).toBeNull();
  });

  it('the Declare done door: primary for the judge of a goal in review; "Retire" on an operation; none for others', () => {
    expect(goalViewFor(goal(), { viewer: me }).declare).toEqual({
      label: GOAL_VIEW_COPY.declareDone,
      primary: true,
    });
    expect(
      goalViewFor(goal({ workKind: "operation", criteria: [] }), { viewer: me })
        .declare?.label
    ).toBe("Retire");
    expect(
      goalViewFor(goal(), { viewer: { userId: OTHER, kind: "person" } }).declare
    ).toBeNull();
  });

  it("carries the parts the hosts assembled by hand (header, rows, count, people, moves, verdicts)", () => {
    const v = goalViewFor(goal(), { viewer: me });
    expect(v.header.owner?.label).toBe("Owner and judge: Camille Laurent");
    expect(v.criteria.map((r) => r.key)).toEqual(["a", "b"]);
    expect(v.count.label).toBe("1 of 2 met · 1 claimed");
    expect(v.participants?.length).toBe(1);
    expect(v.verdicts.mayClose).toBe(true);
    expect(v.mayEdit).toBe(true);
  });
});

describe("an operation and the goal it keeps running (R6)", () => {
  const week = {
    from: "2026-10-19T00:00:00.000Z",
    to: "2026-10-26T00:00:00.000Z",
  };

  it('an operation reads its week — "This week · Not met" — from the pod; other kinds and an unread reading show none', () => {
    const op = goal({
      workKind: "operation",
      periodReading: { ...week, mark: "not_met" },
    });
    expect(goalViewFor(op, { viewer: me }).period).toEqual({
      label: GOAL_VIEW_COPY.period,
      mark: "not_met",
      markLabel: "Not met",
      markView: {
        state: "period_not_met",
        tone: "error",
        glyph: "x",
        label: "Not met",
      },
      ...week,
    });
    expect(
      goalPeriod({
        workKind: "operation",
        periodReading: { ...week, mark: "unmeasured" },
      })?.markLabel
    ).toBe("Not checked");
    // A project carrying a stray reading is not read per week; an older pod sends none.
    expect(
      goalPeriod({
        workKind: "project",
        periodReading: { ...week, mark: "met" },
      })
    ).toBeNull();
    expect(goalPeriod({ workKind: "operation" })).toBeNull();
    // A mark this build does not know never reads as met.
    expect(
      goalPeriod({
        workKind: "operation",
        periodReading: { ...week, mark: "later" },
      })?.mark
    ).toBe("unmeasured");
  });

  it('"Keep it running" is offered to a person on a goal closed as met — never on a miss, an operation, or to an agent', () => {
    const met = goal({ status: "completed", verdict: "met", inReview: false });
    expect(goalViewFor(met, { viewer: me }).keepRunning).toEqual({
      label: "Keep it running",
    });
    expect(
      goalViewFor(goal({ status: "completed", verdict: "partly_met" }), {
        viewer: me,
      }).keepRunning
    ).toBeNull();
    expect(
      goalViewFor(goal({ status: "archived", verdict: "impossible" }), {
        viewer: me,
      }).keepRunning
    ).toBeNull();
    expect(
      goalViewFor({ ...met, workKind: "operation" }, { viewer: me }).keepRunning
    ).toBeNull();
    expect(
      goalViewFor(met, { viewer: { userId: "agent-1", kind: "agent" } })
        .keepRunning
    ).toBeNull();
    expect(goalViewFor(goal(), { viewer: me }).keepRunning).toBeNull();
  });
});

describe("goalDropConditions", () => {
  it('"Drop it if" (the field\'s label) and each condition as written; none ⇒ nothing drawn', () => {
    expect(
      goalDropConditions({ dropConditions: [" Funding stops ", " "] })
    ).toEqual({
      label: "Drop it if",
      items: [{ key: "drop:0", text: "Funding stops" }],
    });
    expect(goalDropConditions({ dropConditions: [] })).toBeNull();
  });
});
