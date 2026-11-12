/**
 * Pillar health — the pure rules. Each row names the candidate rule it RULES
 * OUT; a row that rules out nothing is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  PILLAR_HEALTH_STATES,
  deriveProjectRootHealth,
  derivePillarHealth,
  goalInPillarRollup,
  isGoalBet,
  worstPillarState,
  type PillarGoalFacts,
} from "./pillar-health.js";
import { STATUS_TONE } from "./state.js";
import { STATUS_LABELS } from "../vocabulary/index.js";
import { pillarHealthMark } from "../goal/marks.js";

const active = (more: Partial<PillarGoalFacts> = {}): PillarGoalFacts => ({
  status: "active",
  uncertainty: "clear",
  ...more,
});
const bet = active({ uncertainty: "unknown" });
const paused: PillarGoalFacts = { status: "paused" };

describe("isGoalBet", () => {
  // Rules out "any goal without a verdict is a bet": a clear goal is not.
  it("is a bet only when its way is not known, or it investigates", () => {
    expect(isGoalBet(active())).toBe(false);
    expect(isGoalBet(active({ uncertainty: "complicated" }))).toBe(false);
    for (const u of ["complex", "chaotic", "unknown"]) {
      expect(isGoalBet(active({ uncertainty: u }))).toBe(true);
    }
    expect(
      isGoalBet(active({ uncertainty: null, workKind: "investigation" }))
    ).toBe(true);
  });
  // Rules out "nobody stated it, so assume a bet".
  it("a goal whose uncertainty nobody stated is not a bet", () => {
    expect(isGoalBet({ status: "active" })).toBe(false);
  });
  // Rules out "a judged bet is still a bet".
  it("a verdict ends the bet", () => {
    expect(
      isGoalBet({ status: "completed", verdict: "met", uncertainty: "unknown" })
    ).toBe(false);
  });
});

describe("goalInPillarRollup", () => {
  // Rules out "every goal ever advancing the pillar counts".
  it("keeps live goals and met ones; drops dropped and not-met ones", () => {
    for (const s of ["proposed", "agreed", "ready", "active", "paused"]) {
      expect(goalInPillarRollup({ status: s })).toBe(true);
    }
    expect(goalInPillarRollup({ status: "completed", verdict: "met" })).toBe(
      true
    );
    expect(
      goalInPillarRollup({ status: "completed", verdict: "partly_met" })
    ).toBe(true);
    expect(
      goalInPillarRollup({ status: "completed", verdict: "not_met" })
    ).toBe(false);
    expect(
      goalInPillarRollup({ status: "completed", verdict: "retired" })
    ).toBe(false);
    expect(goalInPillarRollup({ status: "archived", verdict: "mistake" })).toBe(
      false
    );
  });
});

describe("derivePillarHealth — worst-of, with counts, never an average", () => {
  // Rules out "no goal reads as fine".
  it("no goal at all is no_active_goal", () => {
    expect(derivePillarHealth([], false).state).toBe("no_active_goal");
  });
  // Rules out "a goal not started yet runs" (lead decision): proposed,
  // agreed and ready goals make no pillar move, never green.
  it("only goals not started yet is no_active_goal", () => {
    const h = derivePillarHealth(
      [{ status: "proposed" }, { status: "agreed" }, { status: "ready" }],
      false
    );
    expect(h).toMatchObject({
      state: "no_active_goal",
      counts: { open: 0, notStarted: 3 },
    });
    // Beside a running goal it changes nothing.
    expect(
      derivePillarHealth([active(), { status: "ready" }], false)
    ).toMatchObject({
      state: "moving",
      counts: { open: 1, notStarted: 1 },
    });
    // Beside a paused one: stalled, not moving.
    expect(
      derivePillarHealth([paused, { status: "agreed" }], false).state
    ).toBe("stalled");
  });
  // Rules out "met goals keep it green": met is history, nothing runs.
  it("only met goals is no_active_goal, never green", () => {
    const h = derivePillarHealth(
      [{ status: "completed", verdict: "met" }],
      false
    );
    expect(h).toMatchObject({
      state: "no_active_goal",
      counts: { validated: 1, open: 0 },
    });
  });
  // Rules out "a dropped goal holds the pillar up".
  it("a dropped or not-met goal leaves the roll-up", () => {
    const h = derivePillarHealth(
      [
        active(),
        { status: "archived", verdict: "impossible" },
        { status: "completed", verdict: "not_met" },
      ],
      false
    );
    expect(h).toMatchObject({
      state: "moving",
      counts: { open: 1, validated: 0, paused: 0, bet: 0 },
    });
  });
  it("every live goal paused is stalled", () => {
    expect(derivePillarHealth([paused, paused], false)).toMatchObject({
      state: "stalled",
      counts: { paused: 2, open: 0 },
    });
  });
  // Rules out "one running bet among paused goals is fine".
  it("only bets running is unproven, even beside a paused goal", () => {
    expect(derivePillarHealth([bet, bet], false).state).toBe("unproven");
    expect(derivePillarHealth([bet, paused], false).state).toBe("unproven");
  });
  // Rules out an AVERAGE: one healthy goal does not hide a paused one.
  it("a paused goal or a bet beside a running goal is needs_attention", () => {
    expect(derivePillarHealth([active(), paused], false).state).toBe(
      "needs_attention"
    );
    expect(derivePillarHealth([active(), bet], false)).toMatchObject({
      state: "needs_attention",
      counts: { open: 2, bet: 1 },
    });
  });
  it("running goals, none paused, none a bet: moving", () => {
    expect(
      derivePillarHealth(
        [active(), active(), { status: "completed", verdict: "met" }],
        false
      )
    ).toMatchObject({ state: "moving", counts: { open: 2, validated: 1 } });
  });
  // Rules out "stale changes the state": it is its own signal.
  it("staleness is carried beside the state, never folded in", () => {
    const h = derivePillarHealth([active()], true);
    expect(h).toMatchObject({ state: "moving", stale: true });
  });
});

describe("the root and the order", () => {
  it("worst-of follows the declared order", () => {
    expect(worstPillarState("moving", "stalled")).toBe("stalled");
    expect(worstPillarState("no_active_goal", "needs_attention")).toBe(
      "no_active_goal"
    );
    expect(worstPillarState("unproven", "needs_attention")).toBe("unproven");
  });
  // Rules out "a project with no pillar is fine".
  it("no pillar is no_active_goal; counts moving and empty pillars", () => {
    expect(deriveProjectRootHealth([])).toEqual({
      state: "no_active_goal",
      pillarsMoving: 0,
      pillarsTotal: 0,
      pillarsEmpty: 0,
    });
    const h = (state: (typeof PILLAR_HEALTH_STATES)[number]) => ({
      health: {
        state,
        counts: { open: 0, notStarted: 0, validated: 0, bet: 0, paused: 0 },
        stale: false,
        reason: "",
      },
    });
    expect(
      deriveProjectRootHealth([h("moving"), h("no_active_goal"), h("moving")])
    ).toEqual({
      state: "no_active_goal",
      pillarsMoving: 2,
      pillarsTotal: 3,
      pillarsEmpty: 1,
    });
  });
});

describe("words and marks: one door", () => {
  // Rules out a state reaching a person as a raw token, or green when not moving.
  it("every state has curated words, a tone and a mark; only moving is success", () => {
    for (const s of PILLAR_HEALTH_STATES) {
      expect(STATUS_LABELS[s], s).toBeTruthy();
      expect(STATUS_TONE[s], s).toBeTruthy();
      const mark = pillarHealthMark(s);
      expect(mark.label).toBe(STATUS_LABELS[s]);
      expect(mark.tone === "success").toBe(s === "moving");
    }
    expect(STATUS_LABELS.unvalidated_bet).toBe("Unvalidated bet");
    expect(STATUS_LABELS.validated).toBe("Validated");
  });
});
