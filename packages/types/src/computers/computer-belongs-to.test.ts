import { describe, expect, it } from "vitest";
import {
  COMPUTER_BELONGS_TO_LABELS,
  RUN_WHERE_LABELS,
  resolveComputerBelongsToLabel,
  resolveRunWhereLabel,
} from "../vocabulary/index.js";
import {
  COMPUTER_BELONGS_TO,
  isComputerBelongsTo,
  runWhereLine,
} from "./index.js";

describe("whose computer it is (0388)", () => {
  it("has a word for every value, from the vocabulary door", () => {
    expect(Object.keys(COMPUTER_BELONGS_TO_LABELS).sort()).toEqual(
      [...COMPUTER_BELONGS_TO].sort()
    );
    expect(resolveComputerBelongsToLabel("person")).toBe("Personal");
    expect(resolveComputerBelongsToLabel("agent")).toBe("An agent's");
    expect(resolveComputerBelongsToLabel("shared")).toBe("Shared");
  });

  it("humanizes an unknown value and is empty for none", () => {
    expect(resolveComputerBelongsToLabel("team_pool")).toBe("Team pool");
    expect(resolveComputerBelongsToLabel(null)).toBe("");
  });

  it("knows its values and nothing else", () => {
    for (const v of COMPUTER_BELONGS_TO)
      expect(isComputerBelongsTo(v)).toBe(true);
    expect(isComputerBelongsTo("own")).toBe(false);
    expect(isComputerBelongsTo(null)).toBe(false);
  });
});

describe("where a run ran, in words", () => {
  it("names the computer when it has one", () => {
    expect(
      runWhereLine({
        kind: "computer",
        computer: { id: "m1", name: " devbox ", belongsTo: "person" },
      })
    ).toBe("On devbox");
  });

  it("says the kind otherwise, and nothing when unknown", () => {
    expect(runWhereLine({ kind: "pod", computer: null })).toBe("In the pod");
    expect(runWhereLine({ kind: "outside", computer: null })).toBe(
      "Outside the pod"
    );
    expect(runWhereLine({ kind: "computer", computer: null })).toBe(
      "On a computer"
    );
    expect(runWhereLine(null)).toBeNull();
    expect(Object.keys(RUN_WHERE_LABELS).sort()).toEqual([
      "computer",
      "outside",
      "pod",
    ]);
    expect(resolveRunWhereLabel("")).toBe("");
  });
});
