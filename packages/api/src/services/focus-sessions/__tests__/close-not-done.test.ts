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
      unreadMessages: [],
      waiting: { criteria: [], outcomes: [] },
    });
    expect(err.code).toBe("NOT_DONE");
    expect(err.message).toContain("tests-pass (failed)");
    expect(err.message).toContain("sign-off");
    expect(err.message).toContain("synap_evaluate_session");
    expect(err.message).toContain("wait for the person");
    // No agent outcome listed: the claim/withdraw advice is not offered.
    expect(err.message).not.toContain("completeOutput");
    // No unread message listed: the read-and-answer advice is not offered.
    expect(err.message).not.toContain("synap_wait_for_answer");
    expect(err.message).toContain("`reason`");
  });
});

/**
 * ONE rule with the outcome projection: a decision the person answered, whose
 * decision the pod filed, is delivered (`isDecidedByAnswer`, through the
 * shared floor), so it neither refuses nor waits. The fixture is session
 * 2c9791ac as the pod stored it, minus the claims the agent had to add to get
 * past NOT_DONE (2 Nov 2026).
 */
describe("an answered decision does not hold the close", () => {
  const answered = (key: string, label: string) => ({
    key,
    kind: "decision",
    label,
    answer: {
      text: "Advisory only",
      question: "Decides whether rung 4 of the proof ladder can close anything",
      answeredAt: "2026-11-02T02:04:16.803Z",
      answeredBy: "u1",
      askSnapshot: { mode: "choose", chosenKey: "Advisory only" },
    },
    decisionId: `dec-${key}`,
  });
  const slots = [
    {
      key: "options-doc",
      kind: "document",
      label: "Proof-first options document",
      status: "done",
    },
    answered("d1-close-on-proof", "Closing on proof"),
    answered("d2-judge-as-proof", "AI judge as proof"),
    answered("d3-playbooks", "Playbooks: explain or bind"),
    answered("d4-tasks", "Tasks model"),
  ];

  it("closes with nothing open and nothing waiting", () => {
    const work = openRequiredWork({
      criteria: [],
      latest: [],
      agentMovable: new Set(),
      expectedOutputs: slots,
    });
    expect(hasOpenRequiredWork(work)).toBe(false);
    expect(work.waiting).toEqual({ criteria: [], outcomes: [] });
  });

  it("an answer whose decision was never filed still holds it, as the agent's", () => {
    const { decisionId: _d, ...unfiled } = answered("d4-tasks", "Tasks model");
    const work = openRequiredWork({
      criteria: [],
      latest: [],
      agentMovable: new Set(),
      expectedOutputs: [unfiled],
    });
    expect(work.outcomes.map((o) => o.key)).toEqual(["d4-tasks"]);
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
