import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_RUNGS,
  RULE_WIDENABLE_RUNGS,
  canWidenAnswer,
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

describe("which answers a rule can widen", () => {
  const ask = (rung: string) => ({ verdict: "ask" as const, rung });
  const probe = (action: string, profileSlug: string | null = "note") => ({
    action,
    profileSlug,
  });

  it("offers Widen only on an ask decided below the rules store", () => {
    expect(canWidenAnswer(ask("default"), probe("entity.create"))).toBe(true);
    expect(canWidenAnswer(ask("writes-require-proposal"), probe("entity.update"))).toBe(true);
    // Above rung 2.8: no rule reaches it.
    expect(canWidenAnswer(ask("destructive-actions-hard-floor"), probe("entity.delete"))).toBe(false);
    expect(canWidenAnswer(ask("untrusted-origin"), probe("entity.create"))).toBe(false);
    // A propose RULE is revoked, never stacked on.
    expect(canWidenAnswer(ask("governance-rule"), probe("entity.create"))).toBe(false);
    // Nothing to widen when it already acts or is off.
    expect(canWidenAnswer({ verdict: "auto", rung: "default" }, probe("entity.create"))).toBe(false);
    expect(canWidenAnswer({ verdict: "off", rung: "default" }, probe("entity.create"))).toBe(false);
  });

  it("an entity write with no kind is never widened (it would cover every kind)", () => {
    expect(canWidenAnswer(ask("default"), probe("entity.create", null))).toBe(false);
    expect(canWidenAnswer(ask("default"), probe("document.update", null))).toBe(true);
  });

  it("every widenable rung is a rung the contract lists", () => {
    for (const r of RULE_WIDENABLE_RUNGS) expect(GOVERNANCE_RUNGS).toContain(r);
  });
});

