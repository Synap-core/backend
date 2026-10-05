/**
 * A RULE running without a session reaches Happening as ONE row per rule —
 * the shape `signals.ts` `readRuleRuns` → `foldRuleRuns` sends — and the lens
 * model draws it: the rule's door, ×N for its runs, and a FAILED mark when a
 * run in the window failed (never the calm running mark over a failure).
 */
import { describe, it, expect } from "vitest";
import { lensRowOfLiveSignal, type LensPageSignal } from "./page.js";
import { resolveUnitState } from "../units/state.js";

const ruleSignal = (over: Partial<LensPageSignal> = {}): LensPageSignal => ({
  id: "rule-run:a1",
  kind: "rule-run",
  title: "New contact enrichment",
  occurredAt: "2026-10-05T12:00:00Z",
  target: { kind: "automation", id: "a1" },
  ruleRun: { runs: 300, failed: 0, running: true },
  repeatCount: 300,
  ...over,
});

describe("rule-run Happening row", () => {
  it("opens the rule and folds its runs into ×N", () => {
    const row = lensRowOfLiveSignal(ruleSignal());
    expect(row.door).toEqual({ kind: "automation", id: "a1" });
    expect(row.objectKind).toBe("automation");
    expect(row.repeat).toBe("×300");
    expect(row.state).toEqual({ running: true });
  });

  it("a failure inside the window is the mark", () => {
    const row = lensRowOfLiveSignal(
      ruleSignal({
        ruleRun: { runs: 12, failed: 3, running: false },
        repeatCount: 12,
      })
    );
    expect(row.state).toEqual({ failed: true });
    expect(resolveUnitState(row.state).tone).toBe("error");
    expect(resolveUnitState(row.state).tone).not.toBe(
      resolveUnitState({ running: true }).tone
    );
  });

  it("one run is not a repeat", () => {
    const row = lensRowOfLiveSignal(
      ruleSignal({
        ruleRun: { runs: 1, failed: 0, running: true },
        repeatCount: 1,
      })
    );
    expect(row.repeat).toBeNull();
  });

  it("a session row is unchanged (no repeat, running)", () => {
    const row = lensRowOfLiveSignal({
      id: "live:s1",
      kind: "live-session",
      title: "Draft a post",
      target: { kind: "session", id: "s1" },
    });
    expect(row.repeat).toBeNull();
    expect(row.state).toEqual({ running: true });
  });
});
