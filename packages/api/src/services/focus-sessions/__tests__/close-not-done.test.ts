/**
 * `openRequiredWork` — the pure rule behind the F11 close check. The PGlite
 * suite (`close-not-done.pglite.test.ts`) drives it through the real doors
 * and the real `pendingCriteria`; this pins the rows only the pure rule can
 * isolate.
 */
import { describe, it, expect } from "vitest";
import {
  boundReason,
  closeReasonFields,
  hasOpenRequiredWork,
  notDoneAtCloseError,
  openRequiredWork,
} from "../close-not-done.js";

const criterion = { key: "tests-pass", statement: "Tests pass" };

describe("openRequiredWork", () => {
  it("an agent deliverable sharing a criterion's key is judged by the criterion only", () => {
    const slot = {
      key: "tests-pass",
      kind: "code",
      label: "Tests",
      status: "pending",
    };
    const passing = openRequiredWork({
      criteria: [criterion],
      latest: [{ criterionKey: "tests-pass", verdict: "pass" }],
      agentMovable: new Set(),
      expectedOutputs: [slot],
    });
    expect(hasOpenRequiredWork(passing)).toBe(false);

    const ungraded = openRequiredWork({
      criteria: [criterion],
      latest: [],
      agentMovable: new Set(["tests-pass"]),
      expectedOutputs: [slot],
    });
    expect(ungraded.criteria.map((c) => c.key)).toEqual(["tests-pass"]);
    expect(ungraded.outcomes).toEqual([]);
  });

  it("an `unmeasured` row is not a pass; outside `agentMovable` it waits", () => {
    const mine = openRequiredWork({
      criteria: [criterion],
      latest: [{ criterionKey: "tests-pass", verdict: "unmeasured" }],
      agentMovable: new Set(["tests-pass"]),
      expectedOutputs: [],
    });
    expect(mine.criteria).toEqual([
      { key: "tests-pass", statement: "Tests pass", verdict: "unmeasured" },
    ]);
    const spent = openRequiredWork({
      criteria: [criterion],
      latest: [{ criterionKey: "tests-pass", verdict: "fail" }],
      agentMovable: new Set(),
      expectedOutputs: [],
    });
    expect(spent.criteria).toEqual([]);
    expect(spent.waiting.criteria).toEqual([
      { key: "tests-pass", statement: "Tests pass", waitingOn: "escalated" },
    ]);
  });

  it("malformed slots never throw", () => {
    const w = openRequiredWork({
      criteria: [],
      latest: [],
      agentMovable: new Set(),
      expectedOutputs: [null, 7, "x", { kind: "doc", status: "pending" }],
    });
    expect(Array.isArray(w.outcomes)).toBe(true);
  });

  it("the refusal sentence carries every key and only ways out that apply", () => {
    const err = notDoneAtCloseError({
      criteria: [
        { key: "tests-pass", statement: "Tests pass", verdict: "fail" },
      ],
      outcomes: [],
      owedByPerson: [{ key: "sign-off", label: "Founder sign-off" }],
      waiting: { criteria: [], outcomes: [] },
    });
    expect(err.code).toBe("NOT_DONE");
    expect(err.message).toContain("tests-pass (failed)");
    expect(err.message).toContain("sign-off");
    expect(err.message).toContain("synap_evaluate_session");
    expect(err.message).toContain("wait for the person");
    // No agent outcome listed: the claim/withdraw advice is not offered.
    expect(err.message).not.toContain("completeOutput");
    expect(err.message).toContain("`reason`");
  });
});

describe("the close reason", () => {
  it("is trimmed, blank is none, and clipped at 1000", () => {
    expect(boundReason("  ok  ")).toBe("ok");
    expect(boundReason("   ")).toBeUndefined();
    expect(boundReason(42)).toBeUndefined();
    expect(boundReason("x".repeat(1500))?.length).toBe(1000);
  });

  it("is routed by the exit, never both", () => {
    expect(closeReasonFields(undefined, "r")).toEqual({ notDoneReason: "r" });
    expect(closeReasonFields("closed", "r")).toEqual({ notDoneReason: "r" });
    expect(closeReasonFields("cancelled", "r")).toEqual({ cancelReason: "r" });
    expect(closeReasonFields("failed", "r")).toEqual({});
    expect(closeReasonFields("closed", undefined)).toEqual({});
  });
});
