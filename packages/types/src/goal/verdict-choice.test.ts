import { describe, expect, it } from "vitest";
import type { GoalCriterionView, TrackParticipant } from "../units/index.js";
import { goalVerdicts, type GoalLike } from "./model.js";
import {
  goalWriteFailure,
  replacementChoices,
  VERDICT_BAR_COPY,
  verdictChoice,
  type VerdictChoiceInput,
} from "./verdict-choice.js";

const JUDGE = "u-judge";
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
  principalId: JUDGE,
  role: "owner",
  commitment: null,
  commitmentState: null,
  counterText: null,
  reportedReason: null,
  reportedAt: null,
  acknowledgedAt: null,
  decidedBy: JUDGE,
  decidedAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-20T00:00:00.000Z",
  silentSince: null,
  displayName: null,
};
const goal = (over: Partial<GoalLike> = {}): GoalLike => ({
  id: "g1",
  name: "Ship it",
  status: "active",
  verdict: null,
  verdictReason: null,
  direction: null,
  endState: null,
  criteria: [crit("a", "claimed"), crit("b", "claimed")],
  dropConditions: [],
  workKind: "project",
  uncertainty: null,
  kindConfirmedBy: null,
  inReview: true,
  waitingOn: [],
  participants: [owner],
  ...over,
});
const verdictsOf = (g: GoalLike) =>
  goalVerdicts(g, { userId: JUDGE, kind: "person" });
const input = (over: Partial<VerdictChoiceInput> = {}): VerdictChoiceInput => ({
  verdicts: verdictsOf(goal()),
  ending: null,
  picked: null,
  reason: "",
  replacementId: null,
  ...over,
});

describe("verdictChoice — the Declare done bar, one model for desk and phone", () => {
  it("picks nothing for the person: confirm blocked with the reason, nothing to send (UX-2)", () => {
    const v = verdictChoice(input());
    expect(v.choice).toBeNull();
    expect(v.blocked).toBe(VERDICT_BAR_COPY.pickOne);
    expect(v.declaration).toBeNull();
    expect(v.confirmLabel).toBe("Close");
  });

  it("a picked verdict is sent with the confirm’s words", () => {
    const v = verdictChoice(input({ picked: "partly_met" }));
    expect(v.confirmLabel).toBe("Close as partly met");
    expect(v.declaration).toEqual({ to: "completed", verdict: "partly_met" });
  });

  it("re-derives on a re-read: a pick the pod would no longer accept is dropped, not kept behind a grey confirm", () => {
    const allMet = verdictsOf(
      goal({ criteria: [crit("a", "met"), crit("b", "met")] })
    );
    const v = verdictChoice(input({ verdicts: allMet, picked: "partly_met" }));
    expect(
      v.choices.find((c) => c.verdict === "partly_met")?.unavailable
    ).toBeTruthy();
    expect(v.choice).toBeNull();
    expect(v.blocked).toBe(VERDICT_BAR_COPY.pickOne);
    // …and nothing is chosen for them in its place, though "Met" is now open.
    expect(v.choices.find((c) => c.verdict === "met")?.unavailable).toBeNull();
  });

  it("impossible waits for the closer’s words", () => {
    const v = verdictChoice(input({ ending: "drop", picked: "impossible" }));
    expect(v.ask).toEqual({
      kind: "text",
      label: VERDICT_BAR_COPY.impossibleAsk,
    });
    expect(v.blocked).toBe(VERDICT_BAR_COPY.sayWhy);
    expect(
      verdictChoice(
        input({ ending: "drop", picked: "impossible", reason: " API gone " })
      ).declaration
    ).toEqual({
      to: "archived",
      verdict: "impossible",
      verdictReason: "API gone",
    });
  });

  it("replaced picks a goal, never free text", () => {
    const replacements = [{ id: "g2", label: "Ship v2" }];
    const typed = verdictChoice(
      input({ ending: "drop", picked: "replaced", reason: "v2", replacements })
    );
    expect(typed.ask?.kind).toBe("goal");
    expect(typed.blocked).toBe(VERDICT_BAR_COPY.pickReplacement);
    const picked = verdictChoice(
      input({
        ending: "drop",
        picked: "replaced",
        replacementId: "g2",
        replacements,
      })
    );
    expect(picked.declaration).toEqual({
      to: "archived",
      verdict: "replaced",
      verdictReason: "Ship v2",
      replacedById: "g2",
    });
  });

  it('opens on the drop side from a Drop door; an operation confirms "Retire"', () => {
    expect(verdictChoice(input({ initialEnding: "drop" })).legend).toBe(
      VERDICT_BAR_COPY.dropLegend
    );
    const op = verdictsOf(goal({ workKind: "operation", criteria: [] }));
    expect(
      verdictChoice(input({ verdicts: op, picked: "retired" })).confirmLabel
    ).toBe("Retire");
  });

  it("an agent gets no bar", () => {
    expect(
      verdictChoice(
        input({
          verdicts: goalVerdicts(goal(), { userId: JUDGE, kind: "agent" }),
        })
      ).shown
    ).toBe(false);
  });
});

describe("replacementChoices", () => {
  it("other open goals, newest first, never this one or an ended one", () => {
    const list = [
      { id: "g1", name: "Ship it", status: "active" },
      {
        id: "old",
        name: "Old",
        status: "active",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      {
        id: "new",
        name: "",
        status: "proposed",
        updatedAt: "2026-10-20T00:00:00Z",
      },
      { id: "done", name: "Done", status: "completed" },
    ];
    expect(replacementChoices({ id: "g1" }, list).map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
    expect(replacementChoices({ id: "g1" }, list)[0]!.label).toMatch(
      /^Untitled /
    );
  });
});

describe("goalWriteFailure", () => {
  it("a plain sentence naming the act — no server words", () => {
    expect(goalWriteFailure("close")).toMatch(
      /^Couldn't close the \w+\. Nothing changed; try again\.$/
    );
  });

  it("names each commitment move, never the generic edit", () => {
    for (const act of [
      "accept",
      "counter",
      "decline",
      "report_impossible",
    ] as const) {
      const said = goalWriteFailure(act);
      expect(said).not.toBe(goalWriteFailure("edit"));
      expect(said).toMatch(/^Couldn't \w+/);
    }
    expect(goalWriteFailure("counter")).toMatch(/^Couldn't counter /);
    expect(goalWriteFailure("decline")).toMatch(/^Couldn't decline /);
    expect(goalWriteFailure("report_impossible")).toMatch(
      /^Couldn't report impossible /
    );
    expect(goalWriteFailure("keep_running")).toMatch(
      /^Couldn't keep running the \w+\. /
    );
  });
});
