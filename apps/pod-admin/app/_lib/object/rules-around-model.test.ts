import { describe, expect, it } from "vitest";
import type { StatusOfReaction } from "@synap-core/types/units";
import {
  lastOutcomeWords,
  ruleAroundHref,
  ruleAroundMark,
  rulesAroundToShow,
} from "./rules-around-model";

const entry = (over: Partial<StatusOfReaction> = {}): StatusOfReaction => ({
  ruleId: "declared:rollup:rel:post:campaign",
  ruleRowId: null,
  name: "When every post part of a campaign is done, the campaign moves on",
  source: "relation",
  role: "moves",
  when: { category: "done" },
  whenWords: "A post moves to done or lost",
  via: "the campaign it is part of",
  does: "moves to its next status once every part is done",
  paused: false,
  terminal: "propose",
  last: null,
  ...over,
});

describe("When this moves", () => {
  it("is omitted with no rule around it, and says so when the read failed", () => {
    expect(rulesAroundToShow(undefined)).toEqual({ kind: "none" });
    expect(rulesAroundToShow([])).toEqual({ kind: "none" });
    expect(rulesAroundToShow({ status: "unavailable" })).toEqual({
      kind: "failed",
    });
  });

  it("puts the rule that moves it before the ones it sets off", () => {
    const moves = entry();
    const fires = entry({ role: "fires", ruleId: "declared:rollup:x" });
    expect(rulesAroundToShow([fires, moves])).toEqual({
      kind: "ok",
      movesIt: [moves],
      itSetsOff: [fires],
    });
  });

  it("marks a roll-up with its parts' progress, and a paused rule as paused", () => {
    const progress = {
      done: 3,
      of: 5,
      lost: 0,
      open: 2,
      ready: false,
      label: "3 of 5 done",
    };
    expect(ruleAroundMark(entry({ progress }))).toEqual({
      kind: "stale",
      label: "3 of 5 done",
    });
    expect(ruleAroundMark(entry({ progress, paused: true }))).toEqual({
      kind: "unknown",
      label: "Paused",
    });
    expect(ruleAroundMark(entry({ role: "fires" }))).toBeNull();
  });

  it("says what it last did, and opens the rule's own page", () => {
    expect(lastOutcomeWords(entry())).toBeNull();
    expect(
      lastOutcomeWords(
        entry({
          last: {
            outcome: "skipped",
            code: "moved_meanwhile",
            reason: "It was moved meanwhile.",
            at: new Date().toISOString(),
            proposalId: null,
          },
        })
      )
    ).toBe("Last skipped: It was moved meanwhile.");
    expect(ruleAroundHref(entry())).toBe(
      "/rules/declared%3Arollup%3Arel%3Apost%3Acampaign"
    );
  });
});
