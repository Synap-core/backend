import { describe, it, expect } from "vitest";
import { addTurnToCost, ledgerCost, readRunCost } from "./run-cost.js";

const turn = (
  at: string,
  spent?: number,
  cacheRead?: number,
  model?: string
) => ({
  at,
  outcome: "stopped",
  ...(spent !== undefined ? { spentInputTokens: spent } : {}),
  ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
  ...(model ? { model } : {}),
});

describe("addTurnToCost", () => {
  it("counts fresh input as input minus cache reads, and keeps the raw sum", () => {
    const cost = addTurnToCost(
      addTurnToCost(undefined, turn("a", 200_000, 190_000, "claude-haiku-5-5")),
      turn("b", 50_000, undefined, "claude-sonnet-5-5")
    );
    expect(cost).toEqual({
      turns: 2,
      // 10k fresh on the first; the second reported no cache reads: in full.
      freshInputTokens: 60_000,
      rawInputTokens: 250_000,
      cacheReadInputTokens: 190_000,
      models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    });
  });

  it("names each model once, first seen first", () => {
    let cost = addTurnToCost(undefined, turn("a", 1, 0, "m1"));
    cost = addTurnToCost(cost, turn("b", 1, 0, "m2"));
    cost = addTurnToCost(cost, turn("c", 1, 0, "m1"));
    expect(cost.models).toEqual(["m1", "m2"]);
  });

  it("a turn that reported no tokens is counted as a turn, never as zero tokens", () => {
    const cost = addTurnToCost(addTurnToCost(undefined, turn("a", 100)), {
      model: "m",
    });
    expect(cost.turns).toBe(2);
    expect(cost.rawInputTokens).toBe(100);
    expect(cost.unmeasuredTurns).toBe(1);
  });
});

describe("readRunCost", () => {
  it("is null when the session holds no run ledger", () => {
    expect(readRunCost(null)).toBeNull();
    expect(readRunCost({ prompt: "x" })).toBeNull();
  });

  it("reads the running total when the ledger holds one", () => {
    const cost = {
      turns: 14,
      freshInputTokens: 900_000,
      rawInputTokens: 3_000_000,
      cacheReadInputTokens: 2_100_000,
      models: ["m1"],
    };
    expect(
      readRunCost({
        runTurns: { runId: "r", turns: [turn("z", 1, 0)], cost },
      })
    ).toEqual(cost);
  });

  it("sums an older ledger's turns, the first turn once", () => {
    const first = turn("a", 100, 40, "m1");
    expect(
      readRunCost({
        runTurns: {
          runId: "r",
          firstTurn: first,
          turns: [first, turn("b", 10)],
        },
      })
    ).toEqual({
      turns: 2,
      freshInputTokens: 70,
      rawInputTokens: 110,
      cacheReadInputTokens: 40,
      models: ["m1"],
    });
  });

  it("says partial when an older ledger already dropped turns", () => {
    const cost = ledgerCost({
      runId: "r",
      firstTurn: turn("a", 100),
      turns: [turn("x", 10), turn("y", 10)],
    });
    expect(cost).toMatchObject({
      turns: 3,
      rawInputTokens: 120,
      partial: true,
    });
  });
});
