import { describe, expect, it } from "vitest";
import {
  deriveScorecard,
  glanceSummary,
  sessionListVerdictChip,
  unmetPhrase,
  withOptimisticGrade,
  type WireCriterion,
  type WireEvaluation,
} from "./scorecard.js";

const crit = (
  key: string,
  kind: string,
  required?: boolean
): WireCriterion => ({
  key,
  statement: `${key} holds`,
  check: { kind },
  ...(required === undefined ? {} : { required }),
});

const evalRow = (
  criterionKey: string,
  verdict: WireEvaluation["verdict"],
  evaluatorKind: WireEvaluation["evaluatorKind"],
  createdAt = "2026-09-19T10:00:00.000Z",
  rationale?: string
): WireEvaluation => ({
  criterionKey,
  verdict,
  evaluatorKind,
  createdAt,
  ...(rationale ? { rationale } : {}),
});

// The pod lifts `verdict` only when the evaluations read succeeded. Any record works.
const OK_VERDICT = { state: "incomplete" };

function ok(session: Parameters<typeof deriveScorecard>[0]) {
  const view = deriveScorecard(session);
  if (!view || view.state !== "ok")
    throw new Error(`expected ok, got ${JSON.stringify(view)}`);
  return view;
}

describe("deriveScorecard: presence", () => {
  it("is absent when the session declares no criteria (no empty box)", () => {
    expect(deriveScorecard({})).toBeNull();
    expect(
      deriveScorecard({ criteria: [], verdict: OK_VERDICT, evaluations: [] })
    ).toBeNull();
    expect(deriveScorecard({ criteria: null })).toBeNull();
  });

  it('a failed evaluations read is UNREADABLE, never "Not checked"', () => {
    // criteria present (raw row column) but the pod omitted verdict + evaluations
    expect(deriveScorecard({ criteria: [crit("a", "judge")] })).toEqual({
      state: "unreadable",
    });
  });
});

describe("deriveScorecard: order and verdicts", () => {
  const session = {
    criteria: [
      crit("passes", "evidence"),
      crit("unchecked", "judge"),
      crit("fails", "capability"),
      crit("also-unchecked", "evidence"),
    ],
    verdict: OK_VERDICT,
    evaluations: [
      evalRow("passes", "pass", "evidence"),
      evalRow("fails", "fail", "capability"),
    ],
  };

  it("orders failed → not checked → passed, keeping declared order within a verdict", () => {
    expect(ok(session).rows.map((r) => r.key)).toEqual([
      "fails",
      "unchecked",
      "also-unchecked",
      "passes",
    ]);
  });

  it('glance: "1 of 4 failed", failing, error tone. Unmeasured is neutral, not error', () => {
    const view = ok(session);
    // ⚠️ UPDATED 2026-09-21. This asserted `'1 of 4 failed'` — it PINNED the
    // defect: two of these four were never checked, and the glance said so
    // nowhere, inviting the reader to assume they passed. The test even knew,
    // since its own name is about unmeasured being neutral.
    expect(view.summary).toBe("1 of 4 failed · 2 not checked");
    expect(view.verdict.state).toBe("failing");
    // Through the vocabulary door. The state of the CONTRACT is not the same
    // word as one criterion's verdict, and it must not accuse in-flight work.
    expect(view.stateLabel).toBe("Not yet met");
    expect(view.tone).toBe("error");
    const unchecked = view.rows.find((r) => r.key === "unchecked")!;
    expect(unchecked.verdictLabel).toBe("Not checked");
    expect(unchecked.tone).toBe("neutral");
  });

  it("a human row overrides an automated fail (the shared rule, not a local one)", () => {
    const view = ok({
      criteria: [crit("a", "capability")],
      verdict: OK_VERDICT,
      evaluations: [
        evalRow("a", "pass", "human", "2026-09-19T09:00:00.000Z"),
        // later, but not human, so it loses
        evalRow("a", "fail", "capability", "2026-09-19T11:00:00.000Z"),
      ],
    });
    expect(view.rows[0]!.verdict).toBe("pass");
    expect(view.rows[0]!.judgedBy).toBe("Decided by you");
    expect(view.verdict.state).toBe("passing");
    expect(view.summary).toBe("All 1 met");
  });

  it("an optional failure does not fail the session", () => {
    const view = ok({
      criteria: [crit("req", "evidence"), crit("opt", "judge", false)],
      verdict: OK_VERDICT,
      evaluations: [
        evalRow("req", "pass", "evidence"),
        evalRow("opt", "fail", "judge"),
      ],
    });
    expect(view.verdict.state).toBe("passing");
    expect(view.verdict.requiredUnmet).toBe(0);
    expect(view.rows[0]!.required).toBe(false);
    // Passing, but "All" would be false: the optional one failed.
    expect(view.summary).toBe("1 of 2 met");
  });

  it("carries the evaluator in plain words and the rationale", () => {
    const view = ok({
      criteria: [
        crit("a", "judge"),
        crit("b", "capability"),
        crit("c", "evidence"),
      ],
      verdict: OK_VERDICT,
      evaluations: [
        evalRow("a", "fail", "judge", undefined, "Summary omits the risk"),
        { ...evalRow("b", "fail", "capability"), evaluatorId: "dev.typecheck" },
        evalRow("c", "fail", "evidence"),
      ],
    });
    const by = Object.fromEntries(view.rows.map((r) => [r.key, r.judgedBy]));
    expect(by).toEqual({
      a: "AI review",
      b: "Ran dev.typecheck",
      c: "Agent reported evidence",
    });
    expect(view.rows.find((r) => r.key === "a")!.rationale).toBe(
      "Summary omits the risk"
    );
  });
});

describe("deriveScorecard: what a surface draws beside the verdict", () => {
  const view = ok({
    criteria: [
      crit("auto", "capability"),
      crit("mine", "human"),
      crit("bare", ""),
    ],
    verdict: OK_VERDICT,
    evaluations: [
      {
        ...evalRow("auto", "fail", "capability", "2026-09-19T10:00:00.000Z"),
        evidence: { ci: { passed: false, detail: "3 jobs failed" } },
      },
    ],
  });
  const row = (key: string) => view.rows.find((r) => r.key === key)!;

  it("marks the rows a machine checks — a person-only contract has nothing to run", () => {
    expect(row("auto").automated).toBe(true);
    expect(row("mine").automated).toBe(false);
    // No declared check kind: nobody's automated job either.
    expect(row("bare").automated).toBe(false);
  });

  it("carries when the verdict was recorded and the evidence detail, one level deep", () => {
    expect(row("auto").gradedAt).toBe("2026-09-19T10:00:00.000Z");
    expect(row("auto").evidenceDetail).toBe("3 jobs failed");
    // Never graded ⇒ nothing to date, and no invented detail.
    expect(row("mine")).toMatchObject({ gradedAt: null, evidenceDetail: null });
  });
});

describe("deriveScorecard: which rows carry Accept / Send back", () => {
  const view = ok({
    criteria: [
      crit("human-open", "human"),
      crit("auto-pending", "capability"),
      crit("auto-failed", "capability"),
      crit("auto-unmeasured", "judge"),
      crit("passed", "evidence"),
      crit("human-sent-back", "evidence"),
    ],
    verdict: OK_VERDICT,
    evaluations: [
      evalRow("auto-failed", "fail", "capability"),
      evalRow("auto-unmeasured", "unmeasured", "judge"),
      evalRow("passed", "pass", "evidence"),
      evalRow("human-sent-back", "fail", "human"),
    ],
  });
  const gradable = Object.fromEntries(
    view.rows.map((r) => [r.key, r.gradable])
  );

  it("human-check and reported-but-not-passed rows are gradable", () => {
    expect(gradable["human-open"]).toBe(true);
    expect(gradable["auto-failed"]).toBe(true);
    expect(gradable["auto-unmeasured"]).toBe(true);
    // A person who sent it back can still change their mind.
    expect(gradable["human-sent-back"]).toBe(true);
  });

  it("an automated check that has not run, and a passed row, carry no verbs", () => {
    expect(gradable["auto-pending"]).toBe(false);
    expect(gradable["passed"]).toBe(false);
    expect(view.rows.find((r) => r.key === "auto-pending")!.judgedBy).toBe(
      "Waiting for its check"
    );
  });

  it("needsYou is true exactly when some row is gradable", () => {
    expect(view.needsYou).toBe(true);
    const quiet = ok({
      criteria: [crit("auto-pending", "capability")],
      verdict: OK_VERDICT,
      evaluations: [],
    });
    expect(quiet.needsYou).toBe(false);
  });
});

describe("optimistic grade → scorecard (the seam the hook uses)", () => {
  it("Accept flips the row and the glance in one derivation", () => {
    const session = {
      criteria: [crit("a", "judge"), crit("b", "human")],
      verdict: OK_VERDICT,
      evaluations: [evalRow("a", "fail", "judge")],
    };
    const before = ok(session);
    // ⚠️ UPDATED 2026-09-21, same reason as above: `'1 of 2 failed'` hid that
    // `b` had never been checked. The `after` line below was always right —
    // the `incomplete` branch never dropped the unmeasured half. That the two
    // halves of ONE test disagreed is what made the defect invisible.
    expect(before.summary).toBe("1 of 2 failed · 1 not checked");

    const after = ok({
      ...session,
      evaluations: withOptimisticGrade(session.evaluations, {
        criterionKey: "a",
        verdict: "pass",
      }),
    });
    expect(after.rows.find((r) => r.key === "a")!.verdict).toBe("pass");
    expect(after.summary).toBe("1 of 2 met · 1 not checked");
    expect(after.verdict.state).toBe("incomplete");
  });

  it("Send back records a human fail with its reason", () => {
    const rows = withOptimisticGrade([], {
      criterionKey: "b",
      verdict: "fail",
      rationale: "No screenshots",
    });
    const view = ok({
      criteria: [crit("b", "human")],
      verdict: OK_VERDICT,
      evaluations: rows,
    });
    expect(view.rows[0]!.verdict).toBe("fail");
    expect(view.rows[0]!.rationale).toBe("No screenshots");
    expect(view.rows[0]!.judgedBy).toBe("Decided by you");
  });
});

describe("close confirmation + list chip", () => {
  it("unmetPhrase pluralizes and is silent when nothing required is unmet", () => {
    expect(unmetPhrase({ requiredUnmet: 2 })).toBe("2 criteria not met");
    expect(unmetPhrase({ requiredUnmet: 1 })).toBe("1 criterion not met");
    expect(unmetPhrase({ requiredUnmet: 0 })).toBeNull();
    expect(unmetPhrase(null)).toBeNull();
  });

  const v = (
    state: string,
    passed: number,
    total: number,
    requiredUnmet: number
  ) => ({
    verdict: { state, passed, total, requiredUnmet, failed: 0, unmeasured: 0 },
  });

  it("closed + unmet is visible: warning, or error when one failed", () => {
    expect(sessionListVerdictChip(v("incomplete", 2, 4, 2), true)).toEqual({
      label: "2 unmet",
      tone: "warning",
    });
    expect(sessionListVerdictChip(v("failing", 1, 3, 1), true)).toEqual({
      label: "1 unmet",
      tone: "error",
    });
  });

  it("live sessions get a quiet progress chip; closed + passing gets none", () => {
    expect(sessionListVerdictChip(v("incomplete", 2, 4, 2), false)).toEqual({
      label: "2 of 4 met",
      tone: "neutral",
    });
    expect(sessionListVerdictChip(v("passing", 3, 3, 0), true)).toBeNull();
  });

  it("no chip without criteria or without a verdict", () => {
    expect(sessionListVerdictChip(v("none", 0, 0, 0), true)).toBeNull();
    expect(sessionListVerdictChip({}, true)).toBeNull();
    expect(sessionListVerdictChip({ verdict: null }, false)).toBeNull();
  });
});

/**
 * A row that offers no verb AND no verdict is a DEAD ROW — it reports a
 * pending judgement and hands the reader nothing to bring it about.
 *
 * The fixtures below are chosen for where the OLD rule
 * (`humanCheck || Boolean(row)`) and the new one DISAGREE, not for looking
 * representative. `auto-live` is the control that rules the new rule out if it
 * over-reaches: an automated check on a LIVE session really is still coming,
 * so it must stay ungradable exactly as before.
 */
describe("deriveScorecard: a criterion no judge is coming for", () => {
  // No `check` key at all ⇒ neither `human` nor one of the three machine kinds.
  const noCheck = (key: string): WireCriterion => ({
    key,
    statement: `${key} holds`,
  });

  it("an ownerless criterion is the person’s, on a live session", () => {
    const view = ok({
      criteria: [noCheck("ownerless")],
      verdict: OK_VERDICT,
      evaluations: [],
      status: "active",
    });
    expect(view.rows[0]).toMatchObject({
      gradable: true,
      judgedBy: "Waiting for you",
      automated: false,
    });
  });

  it("an automated check that never ran becomes gradable once the session is terminal", () => {
    // The founder's own closed session: two `evidence` criteria, no evaluations.
    const session = {
      criteria: [
        crit("one-proposal", "evidence"),
        crit("lifecycle", "evidence"),
      ],
      verdict: OK_VERDICT,
      evaluations: [],
    };

    const live = ok({ ...session, status: "active" });
    expect(live.rows.map((r) => r.gradable)).toEqual([false, false]);
    expect(live.rows[0].judgedBy).toBe("Waiting for its check");

    const closed = ok({ ...session, status: "closed" });
    expect(closed.rows.map((r) => r.gradable)).toEqual([true, true]);
    expect(closed.rows[0].judgedBy).toBe("Its check never ran");
    // `needsYou` is what a surface reads to decide the section wants attention.
    expect(closed.needsYou).toBe(true);
  });

  it("cancelled and failed are terminal too, not just closed", () => {
    for (const status of ["cancelled", "failed"]) {
      const view = ok({
        criteria: [crit("auto", "judge")],
        verdict: OK_VERDICT,
        evaluations: [],
        status,
      });
      expect(view.rows[0].gradable).toBe(true);
    }
  });

  it("a terminal row that already PASSED stays ungradable", () => {
    // Guards the `v !== 'pass'` half: terminal must widen who may grade, never
    // re-open a settled pass.
    const view = ok({
      criteria: [crit("passed", "evidence")],
      verdict: OK_VERDICT,
      evaluations: [evalRow("passed", "pass", "evidence")],
      status: "closed",
    });
    expect(view.rows[0].gradable).toBe(false);
  });

  it("a missing status is treated as live, never as terminal", () => {
    // Every existing caller passed no status before this field existed; an
    // absent status must not silently unlock verbs on a running session.
    const view = ok({
      criteria: [crit("auto-live", "capability")],
      verdict: OK_VERDICT,
      evaluations: [],
    });
    expect(view.rows[0]).toMatchObject({
      gradable: false,
      judgedBy: "Waiting for its check",
    });
  });
});

describe("glanceSummary: a failing session still says what was never checked", () => {
  // The discriminating input is `failing` WITH unmeasured > 0. A failing
  // verdict with none is the control: it must read exactly as it always did,
  // so the fix cannot be "append a clause everywhere".
  it("keeps the unmeasured count beside the failures", () => {
    expect(
      glanceSummary({
        state: "failing",
        total: 4,
        passed: 0,
        failed: 2,
        unmeasured: 2,
      } as never)
    ).toBe("2 of 4 failed · 2 not checked");
  });

  it("says nothing about unmeasured when there is none", () => {
    expect(
      glanceSummary({
        state: "failing",
        total: 3,
        passed: 1,
        failed: 2,
        unmeasured: 0,
      } as never)
    ).toBe("2 of 3 failed");
  });
});

describe("deriveScorecard — who a human grade belongs to (decision C)", () => {
  const session = {
    criteria: [crit("graded", "human"), crit("pending", "human")],
    verdict: OK_VERDICT,
    evaluations: [evalRow("graded", "pass", "human")],
  };
  const labels = (reader?: { ownerName: string | null }) => {
    const view = deriveScorecard(session, reader);
    if (!view || view.state !== "ok") throw new Error("expected ok");
    return Object.fromEntries(view.rows.map((r) => [r.key, r.judgedBy]));
  };

  it('the owner reads "you"', () => {
    expect(labels()).toEqual({
      graded: "Decided by you",
      pending: "Waiting for you",
    });
  });

  it('a room member reads the owner by name — never "you"', () => {
    expect(labels({ ownerName: "Olive Owner" })).toEqual({
      graded: "Decided by Olive Owner",
      pending: "Waiting for Olive Owner",
    });
  });

  it('an unresolved owner name still never says "you"', () => {
    expect(labels({ ownerName: null })).toEqual({
      graded: "Decided by the owner",
      pending: "Waiting for the owner",
    });
  });
});
