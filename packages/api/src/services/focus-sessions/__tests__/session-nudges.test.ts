/**
 * computeSessionNudges — what a session still owes, as a pure function.
 *
 * Each row below is chosen for the rule it RULES OUT (guards-and-tests.md):
 *   • a `fail` verdict is a GRADE — a rule that meant "not passed" would list it;
 *   • an `unmeasured` row is NOT a grade — a rule that meant "has any row" would
 *     drop it;
 *   • a stageless session with a playbook never nags about `currentStage` — a
 *     rule keyed on `playbookId` instead of the session's own `stages` would;
 *   • `not_final` only at complete — mid-work a non-final stage is normal.
 * The evaluation input is built by the REAL `summarizeEvaluations`, so the
 * "current row per criterion" decision under test is the shared one.
 */
import { describe, it, expect } from "vitest";
import {
  computeSessionNudges,
  shouldOfferPlaybooks,
  NUDGE_PLAYBOOK_CANDIDATES_MAX,
  PLAYBOOK_OFFERED_AT_KEY,
  type NudgeSessionLike,
} from "../session-nudges.js";
import {
  summarizeEvaluations,
  type SessionEvaluationRow,
} from "../evaluations/record.js";

const crit = (key: string) => ({
  key,
  statement: `${key} holds`,
  check: { kind: "evidence", evidenceKey: key },
});

const row = (
  criterionKey: string,
  verdict: "pass" | "fail" | "unmeasured",
  evaluatorKind = "evidence"
) =>
  ({
    criterionKey,
    verdict,
    evaluatorKind,
    createdAt: new Date("2026-09-25T08:00:00Z"),
    attempt: 1,
  }) as unknown as SessionEvaluationRow;

const session = (over: Partial<NudgeSessionLike> = {}): NudgeSessionLike => ({
  playbookId: null,
  origin: "agent",
  currentStage: null,
  stages: [],
  expectedOutputs: [],
  metadata: {},
  ...over,
});

const STAGES = [
  { key: "plan", name: "Plan" },
  { key: "build", name: "Build" },
  { key: "verify", name: "Verify" },
];

describe("computeSessionNudges", () => {
  it("ungraded = no pass/fail verdict: a missing row and an unmeasured row are listed, a FAIL is not", () => {
    const evaluation = summarizeEvaluations(
      [crit("tsc"), crit("lint"), crit("smoke"), crit("docs")],
      [row("tsc", "pass"), row("lint", "fail"), row("smoke", "unmeasured")]
    );
    const n = computeSessionNudges({
      session: session(),
      evaluation,
      phase: "update",
    });
    expect(n?.ungradedCriteria).toEqual(["smoke", "docs"]);
    expect(n?.noCriteria).toBeUndefined();
    expect(n?.hints[0]).toMatch(/evaluate_session/);
  });

  it("every criterion graded and nothing else owed ⇒ undefined (the door omits the field)", () => {
    const evaluation = summarizeEvaluations(
      [crit("tsc"), crit("lint")],
      [row("tsc", "pass"), row("lint", "fail")]
    );
    expect(
      computeSessionNudges({ session: session(), evaluation, phase: "update" })
    ).toBeUndefined();
  });

  it("zero criteria ⇒ noCriteria, never an empty ungraded list", () => {
    const n = computeSessionNudges({
      session: session(),
      evaluation: summarizeEvaluations([], []),
      phase: "update",
    });
    expect(n?.noCriteria).toBe(true);
    expect(n?.ungradedCriteria).toBeUndefined();
  });

  it("stages declared + currentStage unset ⇒ stage 'unset', naming the phases", () => {
    const n = computeSessionNudges({
      session: session({ playbookId: "pb", stages: STAGES }),
      evaluation: summarizeEvaluations([crit("a")], [row("a", "pass")]),
      phase: "update",
    });
    expect(n?.stage).toEqual({
      state: "unset",
      current: null,
      stages: ["plan", "build", "verify"],
    });
  });

  it("currentStage set ⇒ no stage nudge mid-work, even on a non-final stage", () => {
    expect(
      computeSessionNudges({
        session: session({ stages: STAGES, currentStage: "build" }),
        evaluation: summarizeEvaluations([crit("a")], [row("a", "pass")]),
        phase: "update",
      })
    ).toBeUndefined();
  });

  it("at complete, a non-final stage ⇒ 'not_final'; the final stage ⇒ nothing", () => {
    const evaluation = summarizeEvaluations([crit("a")], [row("a", "pass")]);
    expect(
      computeSessionNudges({
        session: session({ stages: STAGES, currentStage: "build" }),
        evaluation,
        phase: "complete",
      })?.stage
    ).toEqual({
      state: "not_final",
      current: "build",
      stages: ["plan", "build", "verify"],
    });
    expect(
      computeSessionNudges({
        session: session({ stages: STAGES, currentStage: "verify" }),
        evaluation,
        phase: "complete",
      })
    ).toBeUndefined();
  });

  it("a STAGELESS playbook session never nags about currentStage (NULL is by design)", () => {
    expect(
      computeSessionNudges({
        session: session({
          playbookId: "pb",
          origin: "playbook",
          stages: [],
          currentStage: null,
        }),
        evaluation: summarizeEvaluations([crit("a")], [row("a", "pass")]),
        phase: "complete",
      })
    ).toBeUndefined();
  });

  it("counts outputs owed by the person — pending human slots only", () => {
    const n = computeSessionNudges({
      session: session({
        expectedOutputs: [
          {
            kind: "doc",
            label: "A",
            owner: "human",
            blockedReason: "decision",
          },
          { kind: "doc", label: "B", owner: "human", status: "done" },
          {
            kind: "doc",
            label: "C",
            owner: "human",
            retiredAt: "2026-09-24T00:00:00Z",
          },
          { kind: "doc", label: "D", owner: "agent" },
        ],
      }),
      evaluation: summarizeEvaluations([crit("a")], [row("a", "pass")]),
      phase: "update",
    });
    expect(n?.owedByPerson).toBe(1);
    expect(n?.hints.join(" ")).toMatch(/session\.channelId/);
  });

  it("playbook candidates ride capped, with a follow hint", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `pb${i}`,
      name: `P${i}`,
      score: 5 - i,
      reason: "You mentioned x",
    }));
    const n = computeSessionNudges({
      session: session(),
      evaluation: summarizeEvaluations([crit("a")], [row("a", "pass")]),
      phase: "update",
      playbookCandidates: candidates,
    });
    expect(n?.playbookCandidates).toHaveLength(NUDGE_PLAYBOOK_CANDIDATES_MAX);
    expect(n?.hints.join(" ")).toMatch(/followPlaybookId/);
  });
});

describe("shouldOfferPlaybooks", () => {
  it("offers only to an unbound, never-offered session", () => {
    expect(shouldOfferPlaybooks(session())).toBe(true);
    expect(shouldOfferPlaybooks(session({ playbookId: "pb" }))).toBe(false);
    expect(shouldOfferPlaybooks(session({ origin: "playbook" }))).toBe(false);
    expect(
      shouldOfferPlaybooks(
        session({ metadata: { [PLAYBOOK_OFFERED_AT_KEY]: "2026-09-25" } })
      )
    ).toBe(false);
  });
});
