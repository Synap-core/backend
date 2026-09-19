/**
 * The session verdict projection. Each row below is chosen to DISCRIMINATE
 * between a correct rule and a plausible wrong one — the wrong rule is named on
 * each case.
 */

import { describe, it, expect } from "vitest";
import {
  computeSessionVerdict,
  latestEvaluationPerCriterion,
  type EvaluationRowLike,
} from "./verdict.js";

const row = (
  criterionKey: string,
  verdict: EvaluationRowLike["verdict"],
  evaluatorKind: EvaluationRowLike["evaluatorKind"],
  createdAt: string,
  attempt = 1
): EvaluationRowLike => ({
  criterionKey,
  verdict,
  evaluatorKind,
  createdAt,
  attempt,
});

describe("latestEvaluationPerCriterion", () => {
  it("latest non-human row wins (wrong rule: first row wins)", () => {
    const latest = latestEvaluationPerCriterion([
      row("a", "fail", "judge", "2026-09-19T10:00:00Z", 1),
      row("a", "pass", "judge", "2026-09-19T11:00:00Z", 2),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.verdict).toBe("pass");
  });

  it("a human pass overrides a LATER judge fail (wrong rule: latest wins)", () => {
    const latest = latestEvaluationPerCriterion([
      row("a", "pass", "human", "2026-09-19T10:00:00Z"),
      row("a", "fail", "judge", "2026-09-19T12:00:00Z", 2),
    ]);
    expect(latest[0]!.evaluatorKind).toBe("human");
    expect(latest[0]!.verdict).toBe("pass");
  });

  it("a judge row after a human row stays human even when it passes (wrong rule: pass wins)", () => {
    const latest = latestEvaluationPerCriterion([
      row("a", "fail", "human", "2026-09-19T10:00:00Z"),
      row("a", "pass", "judge", "2026-09-19T12:00:00Z", 2),
    ]);
    expect(latest[0]!.verdict).toBe("fail");
  });

  it("the later of two human rows wins", () => {
    const latest = latestEvaluationPerCriterion([
      row("a", "fail", "human", "2026-09-19T10:00:00Z"),
      row("a", "pass", "human", "2026-09-19T11:00:00Z"),
    ]);
    expect(latest[0]!.verdict).toBe("pass");
  });

  it("accepts Date and string timestamps alike", () => {
    const latest = latestEvaluationPerCriterion([
      {
        ...row("a", "pass", "evidence", ""),
        createdAt: new Date("2026-09-19T12:00:00Z"),
      },
      row("a", "fail", "evidence", "2026-09-19T10:00:00Z"),
    ]);
    expect(latest[0]!.verdict).toBe("pass");
  });
});

describe("computeSessionVerdict", () => {
  it("no criteria ⇒ none", () => {
    expect(computeSessionVerdict([], []).state).toBe("none");
  });

  it("an unmeasured required criterion is incomplete, NOT failing (wrong rule: unmet = fail)", () => {
    const v = computeSessionVerdict(
      [{ key: "a" }, { key: "b" }],
      [
        { criterionKey: "a", verdict: "pass" },
        { criterionKey: "b", verdict: "unmeasured" },
      ]
    );
    expect(v).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      unmeasured: 1,
      requiredUnmet: 1,
      state: "incomplete",
    });
  });

  it("a criterion with no row counts as unmeasured", () => {
    const v = computeSessionVerdict([{ key: "a" }], []);
    expect(v.unmeasured).toBe(1);
    expect(v.state).toBe("incomplete");
  });

  it("a failed OPTIONAL criterion does not fail the session (wrong rule: any fail = failing)", () => {
    const v = computeSessionVerdict(
      [{ key: "a" }, { key: "b", required: false }],
      [
        { criterionKey: "a", verdict: "pass" },
        { criterionKey: "b", verdict: "fail" },
      ]
    );
    expect(v.failed).toBe(1);
    expect(v.requiredUnmet).toBe(0);
    expect(v.state).toBe("passing");
  });

  it("a failed REQUIRED criterion fails the session even when another is unmeasured", () => {
    const v = computeSessionVerdict(
      [{ key: "a" }, { key: "b" }],
      [{ criterionKey: "a", verdict: "fail" }]
    );
    expect(v.state).toBe("failing");
    expect(v.requiredUnmet).toBe(2);
  });

  it("rows for keys the session does not declare are ignored", () => {
    const v = computeSessionVerdict(
      [{ key: "a" }],
      [
        { criterionKey: "a", verdict: "pass" },
        { criterionKey: "ghost", verdict: "fail" },
      ]
    );
    expect(v).toMatchObject({ total: 1, failed: 0, state: "passing" });
  });

  it("human override flows through end-to-end: human pass beats later judge fail", () => {
    const latest = latestEvaluationPerCriterion([
      row("a", "pass", "human", "2026-09-19T10:00:00Z"),
      row("a", "fail", "judge", "2026-09-19T12:00:00Z", 2),
    ]);
    expect(computeSessionVerdict([{ key: "a" }], latest).state).toBe("passing");
  });
});
