import { describe, expect, it } from "vitest";
import { GOAL_ATTENTION_GROUP_LABELS } from "../vocabulary/index.js";
import {
  GOAL_ATTENTION_GROUPS,
  goalAttention,
  goalAttentionCounts,
  goalAttentionGroup,
  goalAttentionSummary,
} from "./index.js";

const open = {
  status: "active",
  inReview: false,
  waitingOn: [],
  participants: [],
};
const runs = (over = {}) => ({
  health: "healthy" as const,
  workerCount: 1,
  runningCount: 1,
  pendingApprovals: 0,
  ...over,
});

describe("goal attention", () => {
  it("every group has its words, through the vocabulary door", () => {
    expect(Object.keys(GOAL_ATTENTION_GROUP_LABELS).sort()).toEqual(
      [...GOAL_ATTENTION_GROUPS].sort()
    );
  });

  it("one group per goal, first match: ended, needs you, failing, running, until done, paused", () => {
    expect(goalAttentionGroup({ ...open, status: "completed" }, runs())).toBe(
      "off"
    );
    expect(goalAttentionGroup(open, runs({ health: "failing" }))).toBe(
      "failing"
    );
    expect(goalAttentionGroup(open, runs({ health: "off" }))).toBe("failing");
    expect(goalAttentionGroup(open, runs())).toBe("running");
    expect(
      goalAttentionGroup(open, runs({ workerCount: 0, runningCount: 0 }))
    ).toBe("until_done");
    expect(
      goalAttentionGroup(open, runs({ runningCount: 0, health: "paused" }))
    ).toBe("off");
  });

  it("a goal read without runs says so and is never called failing", () => {
    expect(goalAttention(open, null)).toMatchObject({
      group: "until_done",
      label: "Until done",
      runsRead: false,
    });
  });

  it("the summary names each group with goals in it, the verb agreeing, zero clauses dropped", () => {
    const counts = goalAttentionCounts([
      "needs_you",
      "needs_you",
      "failing",
      "running",
      "running",
      "running",
      "running",
      "running",
      "off",
    ]);
    expect(goalAttentionSummary(counts)).toBe(
      "2 need you · 1 failing · 5 run on their own"
    );
    expect(goalAttentionSummary(goalAttentionCounts(["off"]))).toBeNull();
    expect(goalAttentionSummary(goalAttentionCounts(["needs_you"]))).toBe(
      "1 needs you"
    );
  });
});
