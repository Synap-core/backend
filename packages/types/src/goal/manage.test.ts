import { describe, expect, it } from "vitest";
import type { GoalCriterionView, TrackParticipant } from "../units/index.js";
import type { GoalLike } from "./model.js";
import {
  GOAL_MANAGE_COPY,
  goalDirectionPatch,
  goalEditDraftOf,
  goalEditRefusal,
  goalLoopPatch,
  goalLoopView,
  goalManageDoors,
  goalParticipantAddChange,
  goalParticipantAddRefusal,
  goalRemovableParticipants,
  mayMakeItAGoal,
} from "./manage.js";
import { readGoalWrite } from "./write.js";

const OWNER = "u-owner";
const crit = (key: string, statement: string): GoalCriterionView => ({
  key,
  statement,
  check: { kind: "human" },
  acceptance: null,
  mark: "not_started",
  acceptanceState: null,
  meaning: "judged",
  currentValue: null,
  claim: null,
});
const part = (
  id: string,
  principalId: string,
  role: TrackParticipant["role"]
): TrackParticipant => ({
  id,
  principalKind: "person",
  principalId,
  role,
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
  displayName: null,
});
const goal = (over: Partial<GoalLike> = {}): GoalLike => ({
  id: "g1",
  name: "Ship it",
  status: "active",
  verdict: null,
  verdictReason: null,
  direction: null,
  endState: "Beta in 20 hands",
  criteria: [crit("a", "A holds"), crit("b", "B holds")],
  dropConditions: ["Funding stops"],
  workKind: "project",
  uncertainty: "complicated",
  kindConfirmedBy: null,
  inReview: false,
  waitingOn: [],
  participants: [part("p1", OWNER, "owner"), part("p2", "u-d", "delegate")],
  ...over,
});
const me = { userId: OWNER, kind: "person" as const };

describe("goalManageDoors", () => {
  it("the owner gets Edit, Add someone, Confirm kind (while unconfirmed) and Repeat runs (with criteria)", () => {
    expect(goalManageDoors(goal(), me).map((d) => d.key)).toEqual([
      "edit",
      "add_someone",
      "confirm_kind",
      "repeat_runs",
    ]);
    expect(
      goalManageDoors(goal({ kindConfirmedBy: OWNER, criteria: [] }), me).map(
        (d) => d.key
      )
    ).toEqual(["edit", "add_someone"]);
  });

  it("nobody else, no agent, and nothing on an ended goal", () => {
    expect(goalManageDoors(goal(), { userId: "u-d", kind: "person" })).toEqual(
      []
    );
    expect(goalManageDoors(goal(), { userId: OWNER, kind: "agent" })).toEqual(
      []
    );
    expect(
      goalManageDoors(goal({ status: "completed", verdict: "met" }), me)
    ).toEqual([]);
  });
});

describe("edit → setDirection", () => {
  it("opened on the goal as it stands, nothing changed ⇒ nothing to send", () => {
    const draft = goalEditDraftOf(goal());
    expect(goalDirectionPatch(goal(), draft)).toBeNull();
    expect(goalEditRefusal(goal(), draft)).toBe(
      GOAL_MANAGE_COPY.nothingChanged
    );
  });

  it("sends only what changed, each field whole; a picked kind is confirmed", () => {
    const draft = {
      ...goalEditDraftOf(goal()),
      endState: " Beta in 50 hands ",
      workKind: "investigation" as const,
    };
    expect(goalDirectionPatch(goal(), draft)).toEqual({
      endState: "Beta in 50 hands",
      workKind: "investigation",
      confirmKind: true,
    });
  });

  it("a renamed criterion keeps its key; clearing every criterion and drop condition sends null", () => {
    const draft = goalEditDraftOf(goal());
    draft.criteria[0] = {
      ...draft.criteria[0]!,
      statement: "A holds on the phone",
    };
    expect(
      goalDirectionPatch(goal(), draft)?.criteria?.map((c) => [
        c.key,
        c.statement,
      ])
    ).toEqual([
      ["a", "A holds on the phone"],
      ["b", "B holds"],
    ]);
    const cleared = {
      ...goalEditDraftOf(goal()),
      criteria: [],
      dropConditions: [],
    };
    expect(goalDirectionPatch(goal(), cleared)).toMatchObject({
      criteria: null,
      dropConditions: null,
    });
  });

  it("one criterion is refused by the pod’s own count", () => {
    const draft = {
      ...goalEditDraftOf(goal()),
      criteria: [{ statement: "Only one", meaning: "judged" as const }],
    };
    expect(goalEditRefusal(goal(), draft)).not.toBeNull();
    expect(goalEditRefusal(goal(), draft)).not.toBe(
      GOAL_MANAGE_COPY.nothingChanged
    );
  });
});

describe("the loop", () => {
  it("reads OFF when the goal has none, with the default budget; clamps the budget it sends", () => {
    expect(goalLoopView({})).toMatchObject({ on: false, perWeek: 3, max: 14 });
    expect(goalLoopPatch(true, 40)).toEqual({
      loop: { on: true, perWeek: 14 },
    });
    expect(goalLoopPatch(false)).toEqual({ loop: { on: false } });
  });
});

describe("who’s on it: add and remove", () => {
  it("a delegate needs what they commit to", () => {
    expect(
      goalParticipantAddRefusal({
        principalId: null,
        role: "judge",
        commitment: "",
      })
    ).toBe(GOAL_MANAGE_COPY.nobodyChosen);
    expect(
      goalParticipantAddRefusal({
        principalId: "u-x",
        role: "delegate",
        commitment: " ",
      })
    ).toBe(GOAL_MANAGE_COPY.commitmentNeeded);
    expect(
      goalParticipantAddChange({
        principalId: "u-x",
        role: "delegate",
        commitment: " Ship the pins ",
      })
    ).toEqual({
      op: "add",
      principalId: "u-x",
      role: "delegate",
      commitment: "Ship the pins",
    });
  });

  it("the owner or judge may remove anyone but the owner", () => {
    expect(goalRemovableParticipants(goal(), me).map((p) => p.id)).toEqual([
      "p2",
    ]);
    expect(
      goalRemovableParticipants(goal(), { userId: "u-d", kind: "person" })
    ).toEqual([]);
  });
});

describe("Make it a goal", () => {
  it("a goal / objective / okr entity never made into a goal — the pod’s rule", () => {
    expect(mayMakeItAGoal({ profileSlug: "okr", goalIds: [] })).toBe(true);
    expect(mayMakeItAGoal({ profileSlug: "okr", goalIds: ["t1"] })).toBe(false);
    expect(mayMakeItAGoal({ profileSlug: "task", goalIds: [] })).toBe(false);
  });
});

describe("readGoalWrite", () => {
  it("proposed without a proposal id is still proposed, never applied (F17)", () => {
    expect(readGoalWrite({ status: "proposed" })).toEqual({
      outcome: "proposed",
      proposalId: null,
      goalId: null,
    });
    expect(
      readGoalWrite({ status: "proposed", proposalId: "pr1" }).proposalId
    ).toBe("pr1");
  });

  it("unchanged is its own answer; reopen names the new version", () => {
    expect(
      readGoalWrite({ status: "unchanged", track: { id: "g1" } }).outcome
    ).toBe("unchanged");
    expect(readGoalWrite({ status: "started", track: { id: "g2" } })).toEqual({
      outcome: "updated",
      proposalId: null,
      goalId: "g2",
    });
  });
});
