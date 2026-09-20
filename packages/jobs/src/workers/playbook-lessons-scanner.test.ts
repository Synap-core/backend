/**
 * The DB tier is never reached: every DB and IS access is injected via
 * `PlaybookLessonsScanDeps` (the same no-mock import as the blocked-slot and
 * structure-guideline scanner tests).
 *
 * FIXTURE DISCIPLINE — each row rules a candidate rule OUT:
 *   - 1 failure in 3 graded runs (occurrence floor not met) vs 2 in 3 (met);
 *   - 2 failures on an OPTIONAL criterion (the `required` gate is what differs);
 *   - 2 human overrides on an optional criterion (overrides do NOT need
 *     `required` — the arm that would be wrong if the gate were shared);
 *   - two failing criteria on two different stages ⇒ still ONE proposal;
 *   - an EXISTING lesson the IS drops ⇒ the proposal carries the IS's list,
 *     which is what distinguishes replace from append;
 *   - a criterion belonging to NO stage ⇒ no revision (documented gap);
 *   - only 2 graded runs ⇒ nothing, whatever the failures say.
 */

import { describe, it, expect, vi } from "vitest";
import {
  runPlaybookLessonsScan,
  planStageRevisions,
  applyRevisedLessons,
  criterionStageMap,
  MIN_EVALUATED_SESSIONS,
  MIN_FINDING_OCCURRENCES,
  MAX_IS_CALLS_PER_PASS,
  WINDOW_DAYS,
  type PlaybookLessonsScanDeps,
  type PlaybookLessonsProposalData,
  type LessonsScanPlaybook,
  type StoredStage,
} from "./playbook-lessons-scanner.js";
import type {
  ScorecardEvaluationRow,
  ScorecardSessionRow,
} from "../utils/playbook-scorecard.js";

const NOW = new Date("2026-09-19T04:00:00Z");
const PLAYBOOK_ID = "pb-1";
const USER_ID = "u1";

function criterion(
  key: string,
  statement: string,
  opts: { required?: boolean; stageKey?: string } = {}
) {
  return {
    key,
    statement,
    ...(opts.required === undefined ? {} : { required: opts.required }),
    check: { kind: "judge" as const, hint: "look at the outputs" },
    ...(opts.stageKey ? { stageKey: opts.stageKey } : {}),
  };
}

const STAGES: StoredStage[] = [
  {
    key: "plan",
    name: "Plan",
    category: "plan",
    goal: "Decide the approach",
    criteria: [
      criterion("scoped", "The scope is written down", { required: true }),
    ],
    lessons: ["Write the scope before touching code"],
  },
  {
    key: "ship",
    name: "Ship",
    category: "execute",
    criteria: [
      criterion("tsc", "Typecheck passes with 0 errors", { required: true }),
      criterion("nits", "No TODOs left behind", { required: false }),
    ],
  },
];

const PLAYBOOK: LessonsScanPlaybook = {
  id: PLAYBOOK_ID,
  name: "Verified Wave",
  workspaceId: "ws1",
  stages: STAGES,
  userId: USER_ID,
};

/**
 * One closed session declaring `keys` worth of the playbook's criteria.
 *
 * `attached` — the session was bound to the playbook while ALREADY LIVE
 * (`follow-playbook.ts`), as against instantiated from it. It is evidence
 * about the SESSION, not about the playbook, and the scanner must not revise
 * a playbook's stages on the strength of it.
 */
function session(
  id: string,
  keys: string[],
  opts: { attached?: boolean } = {}
): ScorecardSessionRow {
  const all = STAGES.flatMap((s) =>
    ((s.criteria as ReturnType<typeof criterion>[]) ?? []).map((c) => ({
      ...c,
      stageKey: String(s.key),
    }))
  );
  return {
    id,
    playbookId: PLAYBOOK_ID,
    status: "closed",
    criteria: all.filter((c) => keys.includes(c.key)),
    expectedOutputs: [],
    closeEvents: 1,
    attached: opts.attached ?? false,
  };
}

let clock = 0;
function evaluation(
  sessionId: string,
  criterionKey: string,
  verdict: "pass" | "fail" | "unmeasured",
  over: Partial<ScorecardEvaluationRow> = {}
): ScorecardEvaluationRow {
  clock += 1000;
  return {
    sessionId,
    criterionKey,
    verdict,
    evaluatorKind: "ai",
    attempt: 1,
    createdAt: new Date(NOW.getTime() - 86_400_000 + clock),
    rationale: null,
    ...over,
  } as ScorecardEvaluationRow;
}

function makeDeps(
  over: Partial<PlaybookLessonsScanDeps> & {
    sessions?: ScorecardSessionRow[];
    evaluations?: ScorecardEvaluationRow[];
    playbook?: LessonsScanPlaybook;
  } = {}
) {
  const filed: Array<{
    playbook: LessonsScanPlaybook;
    data: PlaybookLessonsProposalData;
  }> = [];
  const reviseLessons = vi.fn(async () => ["ALWAYS run tsc before closing"]);
  const deps: PlaybookLessonsScanDeps = {
    now: () => NOW,
    loadCandidates: async () => [over.playbook ?? PLAYBOOK],
    loadRows: async () => ({
      sessions: over.sessions ?? [],
      evaluations: over.evaluations ?? [],
    }),
    hasOpenRevision: async () => false,
    reviseLessons,
    fileProposal: async (playbook, data) => {
      filed.push({ playbook, data });
      return `prop-${filed.length}`;
    },
    ...over,
  };
  // The spy the deps ACTUALLY carry — an override must be what the test
  // asserts on, or the assertion silently watches an unused mock.
  return {
    deps,
    filed,
    reviseLessons: deps.reviseLessons as typeof reviseLessons,
  };
}

/** 3 graded runs; `failures` of them fail `key`. */
function history(key: string, failures: number, keys = [key]) {
  const sessions = ["s1", "s2", "s3"].map((id) => session(id, keys));
  const evaluations = sessions.map((s, i) =>
    evaluation(s.id, key, i < failures ? "fail" : "pass")
  );
  return { sessions, evaluations };
}

describe("threshold — the 2-of-3 rule", () => {
  it(`fires at ${MIN_FINDING_OCCURRENCES} failures in ${MIN_EVALUATED_SESSIONS} graded runs`, async () => {
    const { deps, filed } = makeDeps(history("tsc", 2));
    expect(await runPlaybookLessonsScan(deps)).toHaveLength(1);
    expect(filed[0].data.evidence.stages[0]).toMatchObject({
      stageKey: "ship",
      findings: [
        {
          statement: "Typecheck passes with 0 errors",
          kind: "failed",
          occurrences: 2,
        },
      ],
    });
  });

  it("an ATTACHED run is NOT failure evidence against the playbook", async () => {
    // THE DISCRIMINATING FIXTURE. One instantiated failure (below the 2-of-3
    // floor) plus two ATTACHED failures of the same criterion. A scanner that
    // filtered on `playbookId` alone sees three failures and files; the rule
    // under test sees one and does not. Flipping `attached` to false on the
    // two rows below is the negative control — it then fires.
    const instantiated = ["s1", "s2", "s3"].map((id) => session(id, ["tsc"]));
    const attached = ["a1", "a2"].map((id) =>
      session(id, ["tsc"], { attached: true })
    );
    const sessions = [...instantiated, ...attached];
    const evaluations = [
      ...instantiated.map((s, i) =>
        evaluation(s.id, "tsc", i < 1 ? "fail" : "pass")
      ),
      ...attached.map((s) => evaluation(s.id, "tsc", "fail")),
    ];
    const { deps, filed, reviseLessons } = makeDeps({ sessions, evaluations });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
    expect(filed).toEqual([]);
    expect(reviseLessons).not.toHaveBeenCalled();
  });

  it("does NOT fire on a single failure", async () => {
    const { deps, filed, reviseLessons } = makeDeps(history("tsc", 1));
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
    expect(filed).toEqual([]);
    // The IS is never paid for a playbook that has nothing to say.
    expect(reviseLessons).not.toHaveBeenCalled();
  });

  it(`does NOT fire with fewer than ${MIN_EVALUATED_SESSIONS} graded runs`, async () => {
    const sessions = ["s1", "s2"].map((id) => session(id, ["tsc"]));
    const { deps } = makeDeps({
      sessions,
      evaluations: sessions.map((s) => evaluation(s.id, "tsc", "fail")),
    });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
  });

  it("an OPTIONAL criterion failing twice is not a finding, but two overrides of it are", async () => {
    const failing = history("nits", 2);
    expect(await runPlaybookLessonsScan(makeDeps(failing).deps)).toEqual([]);

    // Same optional criterion, but a human reversed the AI verdict twice.
    const sessions = ["s1", "s2", "s3"].map((id) => session(id, ["nits"]));
    const evaluations = sessions.flatMap((s, i) => {
      const ai = evaluation(s.id, "nits", "fail");
      if (i === 2) return [ai];
      return [
        ai,
        evaluation(s.id, "nits", "pass", {
          evaluatorKind: "human",
          rationale: "a TODO in a test fixture is fine",
        }),
      ];
    });
    const { deps, filed } = makeDeps({ sessions, evaluations });
    expect(await runPlaybookLessonsScan(deps)).toHaveLength(1);
    expect(filed[0].data.evidence.stages[0].findings).toEqual([
      {
        statement: "No TODOs left behind",
        kind: "overridden",
        occurrences: 2,
        rationale: "a TODO in a test fixture is fine",
      },
    ]);
  });
});

describe("one proposal per playbook", () => {
  it("two failing criteria on two stages produce ONE proposal covering both", async () => {
    const sessions = ["s1", "s2", "s3"].map((id) =>
      session(id, ["tsc", "scoped"])
    );
    const evaluations = sessions.flatMap((s, i) => [
      evaluation(s.id, "tsc", i < 2 ? "fail" : "pass"),
      evaluation(s.id, "scoped", i < 2 ? "fail" : "pass"),
    ]);
    const { deps, filed, reviseLessons } = makeDeps({ sessions, evaluations });

    expect(await runPlaybookLessonsScan(deps)).toEqual(["prop-1"]);
    expect(filed).toHaveLength(1);
    // One IS call PER STAGE, one proposal for the playbook.
    expect(reviseLessons).toHaveBeenCalledTimes(2);
    expect(filed[0].data.evidence.stages.map((s) => s.stageKey)).toEqual([
      "plan",
      "ship",
    ]);
    expect(filed[0].data.data.id).toBe(PLAYBOOK_ID);
    expect(filed[0].data.rationale).toContain("Verified Wave");
    expect(filed[0].data.sourceSessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("a criterion belonging to no stage teaches nothing (documented gap)", async () => {
    const orphan = {
      ...PLAYBOOK,
      // Same criteria on the sessions, but the stages declare none of them.
      stages: [{ key: "ship", name: "Ship", category: "execute" }],
    };
    const { deps } = makeDeps({ ...history("tsc", 3), playbook: orphan });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
  });
});

describe("supersede", () => {
  it("skips a playbook that already has an open playbook/update proposal", async () => {
    const { deps, filed, reviseLessons } = makeDeps({
      ...history("tsc", 3),
      hasOpenRevision: async () => true,
    });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
    expect(filed).toEqual([]);
    // Checked BEFORE the IS is called — the skip costs nothing.
    expect(reviseLessons).not.toHaveBeenCalled();
  });
});

describe("reconcile — the proposal carries the IS's REPLACEMENT list", () => {
  it("drops an existing lesson the IS did not return (replace, never append)", async () => {
    const withLesson: LessonsScanPlaybook = {
      ...PLAYBOOK,
      stages: STAGES.map((s) =>
        s.key === "ship"
          ? {
              ...s,
              lessons: ["Ship on Fridays", "Skip the typecheck if rushed"],
            }
          : s
      ),
    };
    const { deps, filed, reviseLessons } = makeDeps({
      ...history("tsc", 2),
      playbook: withLesson,
      reviseLessons: vi.fn(async () => [
        "NEVER close without a green typecheck",
        "Ship on Fridays",
      ]),
    });

    expect(await runPlaybookLessonsScan(deps)).toHaveLength(1);
    // The existing list was SENT as context…
    expect(reviseLessons).toHaveBeenCalledWith(
      expect.objectContaining({
        playbookName: "Verified Wave",
        stage: { name: "Ship" },
        existingLessons: ["Ship on Fridays", "Skip the typecheck if rushed"],
      })
    );
    // …and the contradicted one is GONE from the proposal, not appended to.
    const stages = filed[0].data.data.stages as StoredStage[];
    const ship = stages.find((s) => s.key === "ship")!;
    expect(ship.lessons).toEqual([
      "NEVER close without a green typecheck",
      "Ship on Fridays",
    ]);
    expect(ship.lessons).not.toContain("Skip the typecheck if rushed");
    // Untouched stages ride through byte-identical.
    expect(stages.find((s) => s.key === "plan")).toBe(STAGES[0]);
  });

  it("files nothing when the reconciled list equals what the stage already had", async () => {
    const same: LessonsScanPlaybook = {
      ...PLAYBOOK,
      stages: STAGES.map((s) =>
        s.key === "ship" ? { ...s, lessons: ["Already known"] } : s
      ),
    };
    const { deps } = makeDeps({
      ...history("tsc", 3),
      playbook: same,
      reviseLessons: vi.fn(async () => ["Already known"]),
    });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
  });

  it("bounds the IS answer with the pod's own reader", async () => {
    const { deps, filed } = makeDeps({
      ...history("tsc", 2),
      reviseLessons: vi.fn(async () => [
        "  spaced   out  ",
        "SPACED OUT",
        "a".repeat(400),
        "one",
        "two",
        "three",
        "four",
      ]),
    });
    await runPlaybookLessonsScan(deps);
    const ship = (filed[0].data.data.stages as StoredStage[]).find(
      (s) => s.key === "ship"
    )!;
    const lessons = ship.lessons as string[];
    expect(lessons).toHaveLength(5); // MAX_STAGE_LESSONS
    expect(lessons[0]).toBe("spaced out"); // collapsed + trimmed
    expect(lessons).not.toContain("SPACED OUT"); // case-insensitive dedupe
    expect(lessons[1]).toHaveLength(200); // STAGE_LESSON_MAX_CHARS
  });
});

describe("IS failure", () => {
  it("files NOTHING when the IS cannot answer", async () => {
    const { deps, filed } = makeDeps({
      ...history("tsc", 3),
      reviseLessons: vi.fn(async () => {
        throw new Error("IS unreachable: connect ECONNREFUSED");
      }),
    });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
    expect(filed).toEqual([]);
  });

  it("a PARTIAL answer is not a proposal — one stage failing skips the playbook", async () => {
    const sessions = ["s1", "s2", "s3"].map((id) =>
      session(id, ["tsc", "scoped"])
    );
    const evaluations = sessions.flatMap((s, i) => [
      evaluation(s.id, "tsc", i < 2 ? "fail" : "pass"),
      evaluation(s.id, "scoped", i < 2 ? "fail" : "pass"),
    ]);
    let call = 0;
    const { deps, filed } = makeDeps({
      sessions,
      evaluations,
      reviseLessons: vi.fn(async () => {
        if (++call === 2) throw new Error("IS 502");
        return ["first stage answered fine"];
      }),
    });
    expect(await runPlaybookLessonsScan(deps)).toEqual([]);
    expect(filed).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("criterionStageMap keeps the FIRST stage declaring a key", () => {
    const map = criterionStageMap([
      { key: "a", criteria: [criterion("k", "s", { required: true })] },
      { key: "b", criteria: [criterion("k", "s", { required: true })] },
    ]);
    expect(map.get("k")).toBe("a");
  });

  it("applyRevisedLessons removes the key rather than storing an empty list", () => {
    const [stage] = applyRevisedLessons(
      [{ key: "ship", name: "Ship", lessons: ["old"] }],
      new Map([["ship", []]])
    );
    expect("lessons" in stage).toBe(false);
  });

  it("planStageRevisions is empty below the graded-run floor", () => {
    expect(
      planStageRevisions(
        STAGES,
        {
          runs: {
            total: 2,
            closed: 2,
            evaluated: 2,
            reopened: 0,
            instantiated: 2,
            attached: 0,
          },
          escalations: 0,
          overrides: 0,
          criteria: [
            {
              key: "tsc",
              statement: "Typecheck passes with 0 errors",
              required: true,
              sessions: 2,
              passed: 0,
              failed: 2,
              unmeasured: 0,
              passRate: 0,
              overrides: 0,
            },
          ],
        },
        new Map()
      )
    ).toEqual([]);
  });
});

describe("one clock", () => {
  it("hands `loadCandidates` the window derived from deps.now(), not the wall clock", async () => {
    const seen: Date[] = [];
    const { deps } = makeDeps({
      ...history("tsc", 2),
      loadCandidates: async (closedAfter: Date) => {
        seen.push(closedAfter);
        return [PLAYBOOK];
      },
    });
    await runPlaybookLessonsScan(deps);
    // The SAME window the scorecard rows are read with — a fake clock moves
    // both or neither. `Date.now()` here would be the real wall clock.
    expect(seen).toEqual([
      new Date(NOW.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000),
    ]);
  });
});

describe("IS call budget", () => {
  /** `n` playbooks, each with ONE stage whose single criterion keeps failing. */
  function manyPlaybooks(n: number) {
    const playbooks: LessonsScanPlaybook[] = [];
    const rows = new Map<
      string,
      { sessions: ScorecardSessionRow[]; evaluations: ScorecardEvaluationRow[] }
    >();
    for (let i = 0; i < n; i += 1) {
      const id = `pb-${i}`;
      playbooks.push({
        id,
        name: `Playbook ${i}`,
        workspaceId: "ws1",
        stages: [
          {
            key: "ship",
            name: "Ship",
            criteria: [
              criterion("tsc", "Typecheck passes", {
                required: true,
                stageKey: "ship",
              }),
            ],
          },
        ],
        userId: USER_ID,
      });
      const sessions = ["a", "b", "c"].map((sfx) => ({
        id: `${id}-${sfx}`,
        playbookId: id,
        status: "closed" as const,
        criteria: [
          criterion("tsc", "Typecheck passes", {
            required: true,
            stageKey: "ship",
          }),
        ],
        expectedOutputs: [],
        closeEvents: 1,
        attached: false,
      })) as ScorecardSessionRow[];
      rows.set(id, {
        sessions,
        evaluations: sessions.map((sess, j) =>
          evaluation(sess.id, "tsc", j < 2 ? "fail" : "pass")
        ),
      });
    }
    return { playbooks, rows };
  }

  it(`spends at most ${MAX_IS_CALLS_PER_PASS} IS calls and leaves the rest for the next pass`, async () => {
    const OVER = 2;
    const { playbooks, rows } = manyPlaybooks(MAX_IS_CALLS_PER_PASS + OVER);
    const { deps, filed, reviseLessons } = makeDeps({
      loadCandidates: async () => playbooks,
      loadRows: async (playbookId: string) => rows.get(playbookId)!,
    });

    const ids = await runPlaybookLessonsScan(deps);

    // One call per revised stage, one stage per playbook ⇒ the budget is the
    // number of playbooks that get a proposal. Without it: all of them.
    expect(reviseLessons).toHaveBeenCalledTimes(MAX_IS_CALLS_PER_PASS);
    expect(ids).toHaveLength(MAX_IS_CALLS_PER_PASS);
    expect(filed).toHaveLength(MAX_IS_CALLS_PER_PASS);
    // Non-vacuity: the fixture really did offer MORE work than the budget.
    expect(playbooks.length).toBe(MAX_IS_CALLS_PER_PASS + OVER);
  });

  it("stops at the budget rather than filing a HALF-revised playbook", async () => {
    // One playbook with two revisable stages, offered when only one call is
    // left: both stages or neither — never a proposal missing a stage.
    const { playbooks, rows } = manyPlaybooks(MAX_IS_CALLS_PER_PASS - 1);
    const twoStage: LessonsScanPlaybook = {
      ...PLAYBOOK,
      id: "pb-two-stage",
      stages: STAGES,
    };
    const both = history("tsc", 2).sessions.map((sess) => ({
      ...sess,
      id: `two-${sess.id}`,
      playbookId: twoStage.id,
      criteria: [
        criterion("tsc", "Typecheck passes with 0 errors", {
          required: true,
          stageKey: "ship",
        }),
        criterion("scoped", "The scope is written down", {
          required: true,
          stageKey: "plan",
        }),
      ],
    })) as ScorecardSessionRow[];
    rows.set(twoStage.id, {
      sessions: both,
      evaluations: both.flatMap((sess, j) => [
        evaluation(sess.id, "tsc", j < 2 ? "fail" : "pass"),
        evaluation(sess.id, "scoped", j < 2 ? "fail" : "pass"),
      ]),
    });

    const { deps, filed, reviseLessons } = makeDeps({
      loadCandidates: async () => [...playbooks, twoStage],
      loadRows: async (playbookId: string) => rows.get(playbookId)!,
    });

    await runPlaybookLessonsScan(deps);

    expect(reviseLessons).toHaveBeenCalledTimes(MAX_IS_CALLS_PER_PASS - 1);
    expect(filed.map((f) => f.playbook.id)).not.toContain(twoStage.id);
  });
});
