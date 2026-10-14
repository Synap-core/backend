import { describe, expect, it } from "vitest";
import {
  cellOfAnswers,
  collapseCells,
  markOfSplit,
  matrixVerdictOf,
  type MatrixProbeAnswer,
} from "./index.js";

const answer = (verdict: MatrixProbeAnswer["verdict"]): MatrixProbeAnswer => ({
  probeKey: "p",
  verdict,
  rung: "rung_2_8",
  reason: "rule",
  ruleId: null,
});

describe("agent matrix rules", () => {
  it("maps the resolver's outcomes to the three verdicts", () => {
    expect(matrixVerdictOf("auto")).toBe("auto");
    expect(matrixVerdictOf("propose")).toBe("ask");
    expect(matrixVerdictOf("deny")).toBe("off");
  });

  it("a cell whose probes agree shows that verdict; disagreeing ones show mixed", () => {
    expect(cellOfAnswers([answer("auto"), answer("auto")]).mark).toBe("auto");
    const mixed = cellOfAnswers([answer("auto"), answer("ask")]);
    expect(mixed.mark).toBe("mixed");
    expect(mixed.split).toEqual({ auto: 1, ask: 1, off: 0 });
  });

  it("a collapsed group never shows one member's verdict — it sums the split", () => {
    const group = collapseCells([
      cellOfAnswers([answer("auto")]),
      cellOfAnswers([answer("ask")]),
      cellOfAnswers([answer("ask")]),
    ]);
    expect(group).toEqual({ mark: "mixed", split: { auto: 1, ask: 2, off: 0 } });
    // …and a group where every member agrees reads as that verdict.
    expect(
      collapseCells([cellOfAnswers([answer("off")]), cellOfAnswers([answer("off")])]).mark
    ).toBe("off");
  });

  it("an empty split is 'off', never a guess", () => {
    expect(markOfSplit({ auto: 0, ask: 0, off: 0 })).toBe("off");
  });
});
