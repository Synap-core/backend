/**
 * `openRequiredWork` — the pure rule behind the F11 close check. The PGlite
 * suite (`close-not-done.pglite.test.ts`) drives it through the real doors;
 * this pins the rows only the pure rule can isolate.
 */
import { describe, it, expect } from "vitest";
import {
  hasOpenRequiredWork,
  notDoneAtCloseError,
  openRequiredWork,
} from "../close-not-done.js";

const criterion = { key: "tests-pass", statement: "Tests pass" };

describe("openRequiredWork", () => {
  it("a deliverable sharing a criterion's key is judged by the criterion only", () => {
    // The outcome model stores `outcomes[{kind:'code', verify:judge}]` as a slot
    // AND a criterion under one key; listing both would double-count it, and
    // the slot's own status is not its measure.
    const passing = openRequiredWork({
      criteria: [criterion],
      evaluations: [{ criterionKey: "tests-pass", verdict: "pass" }],
      expectedOutputs: [
        { key: "tests-pass", kind: "code", label: "Tests", status: "pending" },
      ],
    });
    expect(hasOpenRequiredWork(passing)).toBe(false);

    const ungraded = openRequiredWork({
      criteria: [criterion],
      evaluations: [],
      expectedOutputs: [
        { key: "tests-pass", kind: "code", label: "Tests", status: "pending" },
      ],
    });
    expect(ungraded.criteria.map((c) => c.key)).toEqual(["tests-pass"]);
    expect(ungraded.outcomes).toEqual([]);
  });

  it("an `unmeasured` evaluation row is not a pass", () => {
    const w = openRequiredWork({
      criteria: [criterion],
      evaluations: [{ criterionKey: "tests-pass", verdict: "unmeasured" }],
      expectedOutputs: [],
    });
    expect(w.criteria).toEqual([
      { key: "tests-pass", statement: "Tests pass", verdict: "unmeasured" },
    ]);
  });

  it("the refusal sentence carries every key, so a message-only door still says what is left", () => {
    const err = notDoneAtCloseError({
      criteria: [
        { key: "tests-pass", statement: "Tests pass", verdict: "fail" },
      ],
      outcomes: [{ key: "backend-pr", label: "Backend PR" }],
    });
    expect(err.code).toBe("NOT_DONE");
    expect(err.message).toContain("tests-pass (failed)");
    expect(err.message).toContain("backend-pr");
    expect(err.message).toContain("reason");
  });
});
