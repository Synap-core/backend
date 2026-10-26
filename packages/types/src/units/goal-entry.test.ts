import { describe, expect, it } from "vitest";
import {
  GOAL_CONVERTIBLE_KINDS,
  RAIL_GOAL_PINS_MAX,
  canConvertToGoal,
  goalRailPinKey,
} from "./goal-entry.js";
import { nounInSentence, resolveObjectNoun } from "../vocabulary/index.js";

describe("This week (D4)", () => {
  it("holds three goals, pinned under the track: key", () => {
    expect(RAIL_GOAL_PINS_MAX).toBe(3);
    expect(goalRailPinKey("t1")).toBe("track:t1");
  });
});

describe("canConvertToGoal (D2)", () => {
  it("offers each catalog goal kind that was never converted", () => {
    for (const profileSlug of GOAL_CONVERTIBLE_KINDS) {
      expect(canConvertToGoal({ profileSlug, goalIds: [] })).toBe(true);
    }
    expect([...GOAL_CONVERTIBLE_KINDS].sort()).toEqual([
      "goal",
      "objective",
      "okr",
    ]);
  });

  it("refuses an entity already made a goal — the same kind, one edge", () => {
    expect(canConvertToGoal({ profileSlug: "okr", goalIds: ["t1"] })).toBe(
      false
    );
  });

  it("refuses every other kind, and an entity with no kind", () => {
    for (const profileSlug of [
      "task",
      "project",
      "note",
      "Goal",
      null,
      undefined,
    ]) {
      expect(canConvertToGoal({ profileSlug, goalIds: [] })).toBe(false);
    }
  });

  it('names an OKR as the acronym in a sentence, never "okr"', () => {
    expect(resolveObjectNoun("okr")).toBe("OKR");
    expect(nounInSentence(resolveObjectNoun("okr"))).toBe("OKR");
  });
});
