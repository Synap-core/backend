/**
 * The loop — the pure rules (work model W4). Each fixture names the WRONG
 * rule it rules out; a fixture that rules out nothing is decoration.
 */
import { describe, it, expect } from "vitest";
import {
  GOAL_LOOP_DEFAULT_ON,
  GOAL_LOOP_DEFAULT_PER_WEEK,
  GOAL_LOOP_MAX_PER_WEEK,
  decideGoalNextRun,
  goalCriteriaFailedTwice,
  readGoalLoop,
  type GoalLoopStop,
} from "./goal-loop.js";
import type { GoalRunFacts } from "./goal.js";

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-21T10:00:00.000Z";
const T2 = "2026-10-22T10:00:00.000Z";
const T3 = "2026-10-23T10:00:00.000Z";

const criteria = [
  { key: "a", required: true },
  { key: "b", required: true },
  { key: "opt", required: false },
];

function run(
  sessionId: string,
  rows: Array<{
    key: string;
    verdict: "pass" | "fail" | "unmeasured";
    kind?: "judge" | "evidence" | "human" | "capability";
    at: string;
  }>,
  keys = ["a", "b", "opt"]
): GoalRunFacts {
  return {
    sessionId,
    open: false,
    criterionKeys: keys,
    authors: [],
    evaluations: rows.map((r) => ({
      criterionKey: r.key,
      verdict: r.verdict,
      evaluatorKind: r.kind ?? "judge",
      createdAt: r.at,
    })),
  };
}

describe("readGoalLoop", () => {
  it("reads absent as OFF, whatever the birth default says", () => {
    // Rules out: reading the birth default for a stored goal — flipping
    // GOAL_LOOP_DEFAULT_ON would then switch on every existing goal.
    expect(readGoalLoop(undefined)).toEqual({
      on: false,
      perWeek: GOAL_LOOP_DEFAULT_PER_WEEK,
      onAt: null,
      by: null,
    });
    expect(readGoalLoop({})).toMatchObject({ on: false });
    expect(GOAL_LOOP_DEFAULT_ON).toBe(false);
  });

  it("keeps when and by whom it was switched on; drops a date it cannot read", () => {
    expect(readGoalLoop({ on: true, onAt: T1, by: "u" })).toEqual({
      on: true,
      perWeek: GOAL_LOOP_DEFAULT_PER_WEEK,
      onAt: T1,
      by: "u",
    });
    expect(readGoalLoop({ on: true, onAt: "soon" }).onAt).toBeNull();
  });

  it("clamps a budget out of range instead of trusting it", () => {
    expect(readGoalLoop({ on: true, perWeek: 0 }).perWeek).toBe(1);
    expect(readGoalLoop({ on: true, perWeek: 999 }).perWeek).toBe(
      GOAL_LOOP_MAX_PER_WEEK
    );
    expect(readGoalLoop({ on: true, perWeek: 2.5 }).perWeek).toBe(
      GOAL_LOOP_DEFAULT_PER_WEEK
    );
    expect(readGoalLoop({ on: "yes" }).on).toBe(false);
  });
});

describe("goalCriteriaFailedTwice", () => {
  it("stops on a required key that failed in two runs, naming both", () => {
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "fail", at: T0 }]),
      run("s2", [{ key: "a", verdict: "fail", at: T1 }]),
    ]);
    expect(stops).toEqual([{ key: "a", sessionIds: ["s1", "s2"] }]);
  });

  it("two failures inside ONE run are one run's failure", () => {
    // Rules out: counting rows instead of runs (the session's own two tries).
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [
        { key: "a", verdict: "fail", at: T0 },
        { key: "a", verdict: "fail", at: T1 },
      ]),
    ]);
    expect(stops).toEqual([]);
  });

  it("a run whose latest try passed did not fail", () => {
    // Rules out: any fail row counting, whatever came after it in the run.
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "fail", at: T0 }]),
      run("s2", [
        { key: "a", verdict: "fail", at: T1 },
        { key: "a", verdict: "pass", at: T2 },
      ]),
    ]);
    expect(stops).toEqual([]);
  });

  it("a person's grade starts the count again", () => {
    // Rules out: a loop that stays stopped after the owner answered.
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "fail", at: T0 }]),
      run("s2", [
        { key: "a", verdict: "fail", at: T1 },
        { key: "a", verdict: "fail", kind: "human", at: T2 },
      ]),
      run("s3", [{ key: "a", verdict: "fail", at: T3 }]),
    ]);
    expect(stops).toEqual([]);
  });

  it("a person's own fail is not the loop's failure", () => {
    // Rules out: counting human rows as non-human tries.
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "fail", kind: "human", at: T0 }]),
      run("s2", [{ key: "a", verdict: "fail", kind: "human", at: T1 }]),
    ]);
    expect(stops).toEqual([]);
  });

  it("switching the loop on again starts the count again", () => {
    // Rules out: a stop the owner can only clear by grading.
    const runs = [
      run("s1", [{ key: "a", verdict: "fail", at: T0 }]),
      run("s2", [{ key: "a", verdict: "fail", at: T1 }]),
    ];
    expect(goalCriteriaFailedTwice(criteria, runs, T2)).toEqual([]);
    expect(goalCriteriaFailedTwice(criteria, runs, T0)).toEqual([]);
    expect(goalCriteriaFailedTwice(criteria, runs, null)).toHaveLength(1);
  });

  it("an optional criterion never stops the loop", () => {
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "opt", verdict: "fail", at: T0 }]),
      run("s2", [{ key: "opt", verdict: "fail", at: T1 }]),
    ]);
    expect(stops).toEqual([]);
  });

  it("counts only runs that carry the key", () => {
    // Rules out: a stray row of the same key in a run that does not carry it.
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "fail", at: T0 }]),
      run("s2", [{ key: "a", verdict: "fail", at: T1 }], ["b"]),
    ]);
    expect(stops).toEqual([]);
  });

  it("unmeasured is not a failure", () => {
    const stops = goalCriteriaFailedTwice(criteria, [
      run("s1", [{ key: "a", verdict: "unmeasured", at: T0 }]),
      run("s2", [{ key: "a", verdict: "fail", at: T1 }]),
    ]);
    expect(stops).toEqual([]);
  });
});

describe("decideGoalNextRun", () => {
  const base = {
    loop: { on: true, perWeek: 3 },
    category: "active" as const,
    criteria,
    marks: [
      { key: "a", mark: "not_met" as const },
      { key: "b", mark: "met" as const },
      { key: "opt", mark: "not_started" as const },
    ],
    openRuns: 0,
    pendingProposals: 0,
    proposedThisWeek: 0,
    stops: [] as GoalLoopStop[],
  };

  it("proposes, carrying every criterion not met, in declared order", () => {
    expect(decideGoalNextRun(base)).toEqual({
      propose: true,
      carry: ["a", "opt"],
    });
  });

  it("holds in the stated order", () => {
    expect(
      decideGoalNextRun({ ...base, loop: { on: false, perWeek: 3 } })
    ).toMatchObject({ hold: "loop_off" });
    expect(decideGoalNextRun({ ...base, category: "paused" })).toMatchObject({
      hold: "not_active",
    });
    // Rules out: a goal still being agreed (open category) proposing work.
    expect(decideGoalNextRun({ ...base, category: "open" })).toMatchObject({
      hold: "not_active",
    });
    expect(decideGoalNextRun({ ...base, criteria: [] })).toMatchObject({
      hold: "no_criteria",
    });
    expect(decideGoalNextRun({ ...base, openRuns: 1 })).toMatchObject({
      hold: "run_open",
    });
    expect(decideGoalNextRun({ ...base, pendingProposals: 1 })).toMatchObject({
      hold: "proposal_pending",
    });
    expect(decideGoalNextRun({ ...base, proposedThisWeek: 3 })).toMatchObject({
      hold: "budget_used",
    });
  });

  it("only an unmet REQUIRED criterion fires it", () => {
    // Rules out: an optional criterion keeping a met goal busy.
    expect(
      decideGoalNextRun({
        ...base,
        marks: [
          { key: "a", mark: "met" },
          { key: "b", mark: "met" },
          { key: "opt", mark: "not_started" },
        ],
      })
    ).toMatchObject({ hold: "nothing_unmet" });
  });

  it("a claimed criterion waits on the judge, not on more work", () => {
    expect(
      decideGoalNextRun({
        ...base,
        marks: [
          { key: "a", mark: "claimed" },
          { key: "b", mark: "met" },
        ],
      })
    ).toMatchObject({ hold: "nothing_unmet" });
  });

  it("an unread mark never counts as unmet", () => {
    // Rules out: a failed read proposing work (`null` ≠ not started).
    expect(
      decideGoalNextRun({
        ...base,
        marks: [
          { key: "a", mark: null },
          { key: "b", mark: null },
        ],
      })
    ).toMatchObject({ hold: "nothing_unmet" });
  });

  it("stops on a criterion that failed twice and is still unmet", () => {
    const stop = { key: "a", sessionIds: ["s1", "s2"] };
    expect(decideGoalNextRun({ ...base, stops: [stop] })).toEqual({
      propose: false,
      hold: "stopped",
      stoppedOn: [stop],
    });
  });

  it("a stop on a criterion met since then does not hold the loop", () => {
    // Rules out: a stale stop after a manual run met the criterion.
    expect(
      decideGoalNextRun({
        ...base,
        marks: [
          { key: "a", mark: "met" },
          { key: "b", mark: "not_met" },
        ],
        stops: [{ key: "a", sessionIds: ["s1", "s2"] }],
      })
    ).toEqual({ propose: true, carry: ["b"] });
  });

  it("a stop outranks the budget and a pending proposal", () => {
    // The owner must be asked even when the week's budget is spent.
    expect(
      decideGoalNextRun({
        ...base,
        pendingProposals: 1,
        proposedThisWeek: 3,
        stops: [{ key: "a", sessionIds: ["s1", "s2"] }],
      })
    ).toMatchObject({ hold: "stopped" });
  });
});
