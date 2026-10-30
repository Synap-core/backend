/**
 * What a goal holds — the pure rules (work model W2). Each fixture names the
 * WRONG rule it rules out; a fixture that rules out nothing is decoration.
 */
import { describe, it, expect } from "vitest";
import {
  checkCriterionMeaning,
  checkGoalCriteriaCount,
  criterionMeaning,
  deriveGoalCriteria,
  deriveWaitingOn,
  goalAcceptanceRefusal,
  goalInReview,
  mayAcceptGoalCriterion,
  operationPeriodReading,
  operationWeekStart,
  pullRequestWaitingOn,
  WAITING_ON_REFS_MAX,
  readGoalCriterionAcceptance,
  type GoalCriterionAcceptance,
  type GoalRunFacts,
} from "./goal.js";
import { checkTrackClose } from "./track.js";

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-21T10:00:00.000Z";
const T2 = "2026-10-22T10:00:00.000Z";

const measured = {
  key: "pages",
  statement: "All 12 pages migrated",
  check: { kind: "evidence" as const },
  checkKind: "measured",
};
const judged = {
  key: "tone",
  statement: "The tone fits the brand",
  check: { kind: "judge" as const },
};
const byPerson = {
  key: "signoff",
  statement: "Legal signed off",
  check: { kind: "human" as const },
};

function run(
  over: Partial<GoalRunFacts> & { evaluations?: GoalRunFacts["evaluations"] }
): GoalRunFacts {
  return {
    sessionId: "s1",
    open: false,
    criterionKeys: ["pages", "tone", "signoff"],
    authors: ["user-1", "agent-1"],
    evaluations: [],
    ...over,
  };
}
const row = (
  criterionKey: string,
  verdict: "pass" | "fail" | "unmeasured",
  evaluatorKind: "evidence" | "capability" | "judge" | "human",
  createdAt: string,
  evaluatorId: string | null = null,
  rationale: string | null = null
) => ({
  criterionKey,
  verdict,
  evaluatorKind,
  createdAt,
  evaluatorId,
  rationale,
});

/** The goal's judge in these fixtures (the owner, who also ran "a"). */
const JUDGE = "user-1";
const markOf = (
  c: Parameters<typeof deriveGoalCriteria>[0][number],
  runs: GoalRunFacts[],
  judgeId: string | null = JUDGE
) => deriveGoalCriteria([c], runs, { judgeId })[0]!;

describe("deriveGoalCriteria — one mark per criterion", () => {
  it("no run ever carried it → not_started; an open run carries it → under_way; a closed one → not_met", () => {
    expect(markOf(judged, []).mark).toBe("not_started");
    // Rules out "a run in the goal means under way" — the run must CARRY the key.
    expect(
      markOf(judged, [run({ open: true, criterionKeys: ["other"] })]).mark
    ).toBe("not_started");
    expect(markOf(judged, [run({ open: true })]).mark).toBe("under_way");
    expect(markOf(judged, [run({ open: false })]).mark).toBe("not_met");
  });

  it("an AI judge's pass is a CLAIM waiting on the goal's judge, never met (R9)", () => {
    const s = markOf(judged, [
      run({ evaluations: [row("tone", "pass", "judge", T1, "model-x")] }),
    ]);
    expect(s).toMatchObject({ mark: "claimed", acceptanceState: "waiting" });
  });

  it("a person's pass is met — and wins over a NEWER non-human fail (as for a session)", () => {
    const s = markOf(byPerson, [
      run({
        sessionId: "a",
        evaluations: [row("signoff", "pass", "human", T0, "user-1")],
      }),
      run({
        sessionId: "b",
        evaluations: [row("signoff", "fail", "judge", T2, "model-x")],
      }),
    ]);
    expect(s).toMatchObject({ mark: "met", acceptanceState: "accepted" });
  });

  it("ANOTHER person's pass is a claim waiting on the judge, never their own acceptance (F2)", () => {
    // Rules out "any person's grade accepts": a delegate grading their own
    // run would accept their own work and bypass the judge.
    const delegates = markOf(byPerson, [
      run({ evaluations: [row("signoff", "pass", "human", T1, "delegate-9")] }),
    ]);
    expect(delegates).toMatchObject({
      mark: "claimed",
      acceptanceState: "waiting",
    });
    // The judge's own grade is their acceptance.
    expect(
      markOf(byPerson, [
        run({ evaluations: [row("signoff", "pass", "human", T1, JUDGE)] }),
      ]).mark
    ).toBe("met");
    // An unknown judge accepts nothing on anyone's behalf.
    expect(
      markOf(
        byPerson,
        [run({ evaluations: [row("signoff", "pass", "human", T1, JUDGE)] })],
        null
      ).mark
    ).toBe("claimed");
  });

  it("a MEASURED pass by a capability is accepted automatically", () => {
    const c = { ...measured, check: { kind: "capability" as const } };
    expect(
      markOf(c, [
        run({
          evaluations: [row("pages", "pass", "capability", T1, "verify")],
        }),
      ]).mark
    ).toBe("met");
  });

  it("a measured EVIDENCE pass posted by the author stays a claim; by someone else it is met (R9)", () => {
    // Rules out "every measured pass auto-accepts".
    expect(
      markOf(measured, [
        run({ evaluations: [row("pages", "pass", "evidence", T1, "agent-1")] }),
      ]).mark
    ).toBe("claimed");
    expect(
      markOf(measured, [
        run({ evaluations: [row("pages", "pass", "evidence", T1, "ci-bot")] }),
      ]).mark
    ).toBe("met");
  });

  it("an evidence pass on a criterion that is NOT measured never auto-accepts", () => {
    // Rules out "an automatic evaluator accepts whatever it checks".
    const handed = { ...measured, checkKind: "handed_over" };
    expect(
      markOf(handed, [
        run({ evaluations: [row("pages", "pass", "evidence", T1, "ci-bot")] }),
      ]).mark
    ).toBe("claimed");
  });

  it("the judge's acceptance makes a claim met; a later regression undoes it", () => {
    const accepted: GoalCriterionAcceptance = {
      decision: "accepted",
      by: "user-1",
      at: T1,
    };
    const claim = row("tone", "pass", "judge", T0, "model-x");
    expect(
      markOf({ ...judged, acceptance: accepted }, [
        run({ evaluations: [claim] }),
      ])
    ).toMatchObject({ mark: "met", acceptanceState: "accepted" });
    const regressed = markOf({ ...judged, acceptance: accepted }, [
      run({
        open: true,
        evaluations: [claim, row("tone", "fail", "judge", T2, "model-x")],
      }),
    ]);
    expect(regressed.mark).toBe("under_way");
  });

  it("sent back: stands until a NEWER claim reopens review", () => {
    const back: GoalCriterionAcceptance = {
      decision: "changes_asked",
      by: "user-1",
      at: T1,
      note: "Warmer",
    };
    const old = row("tone", "pass", "judge", T0, "model-x");
    expect(
      markOf({ ...judged, acceptance: back }, [
        run({ open: true, evaluations: [old] }),
      ])
    ).toMatchObject({ mark: "under_way", acceptanceState: "changes_asked" });
    expect(
      markOf({ ...judged, acceptance: back }, [
        run({
          evaluations: [old, row("tone", "pass", "judge", T2, "model-x")],
        }),
      ])
    ).toMatchObject({ mark: "claimed", acceptanceState: "waiting" });
  });

  it("the claim names who, which run and the check's words; null when nothing passes", () => {
    const s = markOf(judged, [
      run({
        sessionId: "run-7",
        ownerId: "user-3",
        evaluations: [
          {
            ...row("tone", "pass", "judge", T1, "model-x", "Warm, on brand"),
            id: "ev-1",
          },
        ],
      }),
    ]);
    // An AI judge's pass: the RUN claims it (its owner), not the model.
    expect(s.claim).toEqual({
      by: "user-3",
      sessionId: "run-7",
      evaluationId: "ev-1",
      evaluatorKind: "judge",
      note: "Warm, on brand",
      at: T1,
    });
    // An agent's evidence: the agent claims it.
    expect(
      markOf(measured, [
        run({ evaluations: [row("pages", "pass", "evidence", T1, "agent-1")] }),
      ]).claim?.by
    ).toBe("agent-1");
    expect(markOf(judged, [run({ open: true })]).claim).toBeNull();
  });

  it("a measured criterion carries its latest measured value; others never do", () => {
    const s = markOf(measured, [
      run({
        evaluations: [
          row("pages", "fail", "evidence", T0, "agent-1", "6 of 12"),
          row("pages", "fail", "evidence", T1, "agent-1", "9 of 12"),
        ],
      }),
    ]);
    expect(s.currentValue).toBe("9 of 12");
    expect(
      markOf(judged, [
        run({
          evaluations: [row("tone", "fail", "judge", T1, "m", "too cold")],
        }),
      ]).currentValue
    ).toBeNull();
  });
});

describe("goalInReview — every REQUIRED criterion met or claimed, one at least claimed", () => {
  const criteria = [judged, { ...byPerson, required: false }];
  it("all required claimed → in review; an optional one does not hold it back", () => {
    expect(
      goalInReview(criteria, [
        { key: "tone", mark: "claimed" },
        { key: "signoff", mark: "not_started" },
      ])
    ).toBe(true);
  });
  it("one required met and one claimed → STILL in review (F1: mixed goals, a first acceptance)", () => {
    // Rules out "every required claimed": a measured criterion that passed,
    // or the judge's first acceptance, would hide the claim still waiting.
    expect(
      goalInReview(
        [judged, byPerson],
        [
          { key: "tone", mark: "claimed" },
          { key: "signoff", mark: "met" },
        ]
      )
    ).toBe(true);
  });
  it("all met (nothing waits on the judge), or one required not claimed → not in review; no criteria → never", () => {
    expect(
      goalInReview(
        [judged, byPerson],
        [
          { key: "tone", mark: "met" },
          { key: "signoff", mark: "met" },
        ]
      )
    ).toBe(false);
    expect(
      goalInReview(
        [judged, byPerson],
        [
          { key: "tone", mark: "claimed" },
          { key: "signoff", mark: "under_way" },
        ]
      )
    ).toBe(false);
    expect(goalInReview([], [])).toBe(false);
  });
  it("an optional claimed criterion counts as the one waiting", () => {
    expect(
      goalInReview(criteria, [
        { key: "tone", mark: "met" },
        { key: "signoff", mark: "claimed" },
      ])
    ).toBe(true);
  });
});

describe("goalAcceptanceRefusal — F14, the judge decides about CLAIMS", () => {
  const ask = (
    decision: "accepted" | "changes_asked" | "rejected",
    mark: Parameters<typeof goalAcceptanceRefusal>[0]["mark"],
    meaning: Parameters<typeof goalAcceptanceRefusal>[0]["meaning"],
    note: string | null = null
  ) => goalAcceptanceRefusal({ decision, mark, meaning, note });
  it("accepting needs a claim — not a criterion nobody worked or already met", () => {
    expect(ask("accepted", "claimed", "judged")).toBeNull();
    expect(ask("accepted", "not_started", "judged")).toMatch(/Nothing claims/);
    expect(ask("accepted", "under_way", "handed_over")).toMatch(
      /Nothing claims/
    );
    expect(ask("accepted", "met", "judged")).toMatch(/already met/);
  });
  it("an outside party's decision or a certificate: recorded with its source, claim or not", () => {
    expect(ask("accepted", "not_started", "decided_outside")).toMatch(/source/);
    expect(
      ask("accepted", "not_started", "decided_outside", "Board vote, 3 Oct")
    ).toBeNull();
    expect(ask("accepted", "not_met", "certified", "ISO cert #42")).toBeNull();
  });
  it("sending back needs a note; rejecting stays open", () => {
    expect(ask("changes_asked", "claimed", "judged")).toMatch(/needs a note/);
    expect(ask("changes_asked", "claimed", "judged", "Warmer")).toBeNull();
    expect(ask("rejected", "not_started", "judged")).toBeNull();
  });
});

describe("who may accept (R2, R9)", () => {
  it("an agent never; a person only as judge; a check only a measured criterion, not its author's", () => {
    expect(mayAcceptGoalCriterion(judged, { kind: "agent" })).toMatch(/agent/);
    expect(
      mayAcceptGoalCriterion(judged, { kind: "person", isJudge: false })
    ).toMatch(/judge/);
    expect(
      mayAcceptGoalCriterion(judged, { kind: "person", isJudge: true })
    ).toBeNull();
    expect(
      mayAcceptGoalCriterion(judged, { kind: "automatic", isAuthor: false })
    ).toMatch(/not a measured/);
    expect(
      mayAcceptGoalCriterion(measured, { kind: "automatic", isAuthor: true })
    ).toMatch(/did the work/);
    expect(
      mayAcceptGoalCriterion(measured, { kind: "automatic", isAuthor: false })
    ).toBeNull();
  });
});

describe("criteria rules", () => {
  it("none, or 2 to 5", () => {
    expect(checkGoalCriteriaCount(0)).toBeNull();
    expect(checkGoalCriteriaCount(1)).toMatch(/2 to 5/);
    expect(checkGoalCriteriaCount(2)).toBeNull();
    expect(checkGoalCriteriaCount(5)).toBeNull();
    expect(checkGoalCriteriaCount(6)).toMatch(/not 6/);
  });
  it("a meaning its check cannot carry is refused; learning is about the method", () => {
    expect(
      checkCriterionMeaning({ ...byPerson, checkKind: "measured" })
    ).toMatch(/checked by evidence or capability/);
    expect(
      checkCriterionMeaning({ ...byPerson, checkKind: "certified" })
    ).toBeNull();
    expect(
      checkCriterionMeaning({
        ...judged,
        checkKind: "learning",
        about: "result",
      })
    ).toMatch(/method/);
    expect(criterionMeaning({ ...judged, about: "method" })).toBe("learning");
    expect(criterionMeaning({ ...measured, checkKind: undefined })).toBe(
      "measured"
    );
  });
  it("a stored acceptance is read tolerantly", () => {
    expect(
      readGoalCriterionAcceptance({ decision: "nope", by: "u", at: T0 })
    ).toBeNull();
    expect(
      readGoalCriterionAcceptance({
        decision: "accepted",
        by: "u",
        at: T0,
        note: " ",
      })
    ).toEqual({
      decision: "accepted",
      by: "u",
      at: T0,
    });
  });
});

describe("waiting on (R4)", () => {
  it("one mark per reason, in reason order, with counts", () => {
    expect(
      deriveWaitingOn([
        { kind: "blocked_by" },
        { kind: "owed_slot", blockedReason: "credential" },
        { kind: "pending_proposal" },
        { kind: "owed_slot" },
        { kind: "owed_slot", blockedReason: "permission" },
      ])
    ).toEqual([
      { reason: "input", count: 1 },
      { reason: "approval", count: 1 },
      { reason: "access", count: 2 },
      { reason: "another_work", count: 1 },
    ]);
    expect(deriveWaitingOn([])).toEqual([]);
  });
  it("a hold, an open PR and an open sub-session each make their mark", () => {
    expect(
      deriveWaitingOn([
        { kind: "hold", on: "date" },
        { kind: "hold", on: "external" },
        { kind: "hold", on: "person" },
        { kind: "work_unit", state: "open", checks: "passed" },
        { kind: "work_unit", state: "open" },
        { kind: "child_session" },
      ])
    ).toEqual([
      { reason: "input", count: 1 },
      { reason: "another_work", count: 1 },
      { reason: "external", count: 3 },
      { reason: "date", count: 1 },
    ]);
  });
  it("a hold on nobody, an unspecified hold, a red / merged / closed PR make no mark", () => {
    // Rules out counting every source: these name nothing anyone waits on.
    expect(
      deriveWaitingOn([
        { kind: "hold", on: "nobody" },
        { kind: "hold", on: "unspecified" },
        { kind: "work_unit", state: "open", checks: "failed" },
        { kind: "work_unit", state: "merged", checks: "passed" },
        { kind: "work_unit", state: "closed" },
      ])
    ).toEqual([]);
    expect(pullRequestWaitingOn({ state: "open" })).toBe("external");
    // A green PR waits on the merge queue (the bot enqueues it), not a person.
    expect(pullRequestWaitingOn({ state: "open", checks: "passed" })).toBe(
      "external"
    );
  });
  it("refs say WHAT is waited on, capped per mark; the count stays whole", () => {
    const refs = Array.from({ length: WAITING_ON_REFS_MAX + 2 }, (_, i) => ({
      kind: "session" as const,
      id: `s${i}`,
      label: `Lane ${i}`,
    }));
    const [mark] = deriveWaitingOn([
      ...refs.map((ref) => ({ kind: "child_session" as const, ref })),
      { kind: "blocked_by" },
    ]);
    expect(mark!.count).toBe(WAITING_ON_REFS_MAX + 3);
    expect(mark!.refs).toEqual(
      refs
        .slice(0, WAITING_ON_REFS_MAX)
        .map((r) => ({ ...r, waitKind: "another_work" }))
    );
    // A mark no source named carries no refs at all (never `[]`).
    expect(deriveWaitingOn([{ kind: "pending_proposal" }])).toEqual([
      { reason: "approval", count: 1 },
    ]);
  });
});

describe("the close rule with criteria (checkTrackClose)", () => {
  const marks = (m: Record<string, string>, optional: string[] = []) =>
    Object.entries(m).map(([key, mark]) => ({
      key,
      mark,
      ...(optional.includes(key) ? { required: false } : {}),
    }));
  it("met needs every REQUIRED criterion met; an optional one may stay open", () => {
    expect(
      checkTrackClose(
        "completed",
        { verdict: "met" },
        marks({ a: "met", b: "claimed" })
      )
    ).toMatch(/not yet: b/);
    expect(
      checkTrackClose(
        "completed",
        { verdict: "met" },
        marks({ a: "met", b: "under_way" }, ["b"])
      )
    ).toBeNull();
  });
  it("partly_met / not_met need one criterion not met", () => {
    expect(
      checkTrackClose(
        "completed",
        { verdict: "partly_met" },
        marks({ a: "met", b: "met" })
      )
    ).toMatch(/close it as met/);
    expect(
      checkTrackClose(
        "completed",
        { verdict: "not_met" },
        marks({ a: "met", b: "not_met" })
      )
    ).toBeNull();
  });
  it("a lasting goal (no criteria) closes on its judge's word", () => {
    expect(checkTrackClose("completed", { verdict: "met" }, [])).toBeNull();
    expect(checkTrackClose("completed", { verdict: "met" })).toBeNull();
  });
});

describe("R6 — an operation is read per period", () => {
  // T1/T2 fall in the week of Mon 19 Oct; a Sunday-night row is last week's.
  const SUNDAY = "2026-10-18T22:00:00.000Z";
  const week = {
    from: operationWeekStart(new Date(T2)),
    to: new Date("2026-10-26T00:00:00.000Z"),
  };
  const criteria = [judged, { ...byPerson, required: false }];

  it("the week starts Monday 00:00 UTC", () => {
    expect(operationWeekStart(new Date(T2)).toISOString()).toBe(
      "2026-10-19T00:00:00.000Z"
    );
    expect(
      operationWeekStart(new Date("2026-10-19T00:00:00.000Z")).toISOString()
    ).toBe("2026-10-19T00:00:00.000Z");
  });

  it("met when every required criterion's grade IN the period passes", () => {
    const r = operationPeriodReading(
      criteria,
      [run({ evaluations: [row("tone", "pass", "judge", T1)] })],
      week
    );
    expect(r).toEqual({
      from: "2026-10-19T00:00:00.000Z",
      to: "2026-10-26T00:00:00.000Z",
      mark: "met",
    });
  });

  it("a pass from LAST week does not make this week met — unmeasured", () => {
    // Rules out reading the latest grade regardless of the period.
    expect(
      operationPeriodReading(
        criteria,
        [run({ evaluations: [row("tone", "pass", "judge", SUNDAY)] })],
        week
      ).mark
    ).toBe("unmeasured");
  });

  it("the latest grade in the period wins: a later fail is not met; unmeasured is not a fail", () => {
    expect(
      operationPeriodReading(
        criteria,
        [
          run({
            evaluations: [
              row("tone", "pass", "judge", T1),
              row("tone", "fail", "judge", T2),
            ],
          }),
        ],
        week
      ).mark
    ).toBe("not_met");
    expect(
      operationPeriodReading(
        criteria,
        [run({ evaluations: [row("tone", "unmeasured", "judge", T1)] })],
        week
      ).mark
    ).toBe("unmeasured");
  });
});
