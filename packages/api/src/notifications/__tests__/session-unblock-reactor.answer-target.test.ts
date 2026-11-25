/**
 * W5 (work model): an answer RE-CHECKS what its slot names (`unblocksTarget`,
 * `SlotUnblocksTarget`). The agent declares the target, so the reactor never
 * writes the person's verdict or attestation (W5 review, item 3): the rule
 * (`answerTargetMove`, pure) and the reactor that runs it on
 * `focus_session.slot_answered` and `slot_attested` through the existing
 * re-check doors (the declared-grade producer, the criteria re-check, the
 * evidence read). Those doors are mocked here: what is under test is which
 * one the answer reaches, and that the grade and attest doors are NEVER
 * reached. The real doors run end to end in
 * `declared-grade-doors.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { surfaceMock, recheckMock, evidenceMock, gradeMock, attestMock, queue } =
  vi.hoisted(() => ({
    surfaceMock: vi.fn(async (_id: unknown) => ({ filed: [], outputs: null })),
    recheckMock: vi.fn(async (_p: unknown) => ({})),
    evidenceMock: vi.fn(async (_p: unknown) => ({ satisfied: [] })),
    gradeMock: vi.fn(async (_p: unknown) => ({})),
    attestMock: vi.fn(async (_p: unknown) => ({ status: "attested" })),
    queue: [] as unknown[][],
  }));

// PARTIAL mock: only `db` is replaced — see the total-mock ratchet tripwire.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const node: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve),
  };
  for (const m of ["select", "from", "where", "limit"]) node[m] = () => node;
  return { ...actual, db: { select: () => node } };
});

vi.mock(
  "../../services/focus-sessions/evaluations/record.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fileDeclaredGradeSlots: surfaceMock,
  })
);
vi.mock(
  "../../services/dev-loop/session-outcome-door.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reevaluateCriteria: recheckMock,
  })
);
vi.mock(
  "../../services/focus-sessions/satisfy-expected-output.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    satisfyClaimsByEvidence: evidenceMock,
    attestExpectedOutput: attestMock,
  })
);
vi.mock(
  "../../services/focus-sessions/evaluations/evaluate.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    gradeCriterionAfterAct: gradeMock,
    gradeCriterionAsOwner: gradeMock,
  })
);

const { answerTargetMove, sessionUnblockNotifyReactor } =
  await import("../session-unblock-reactor.js");

const SESSION = "session-1";
const OWNER = "owner-1";
const HUMAN_CRITERION = {
  key: "contract-signed",
  statement: "The contract is signed",
  check: { kind: "human" as const },
};
const EVIDENCE_CRITERION = {
  key: "tests-pass",
  statement: "The tests pass",
  check: { kind: "evidence" as const, evidenceKey: "tests" },
};

const JUDGE_CRITERION = {
  key: "copy-is-clear",
  statement: "The copy is clear",
  check: { kind: "judge" as const },
};

const move = (target: unknown, value: unknown = { type: "text" }) =>
  answerTargetMove({
    target,
    value,
    criteria: [HUMAN_CRITERION, EVIDENCE_CRITERION, JUDGE_CRITERION],
  });

describe("answerTargetMove — what an answer re-checks", () => {
  it("a criterion the person grades: their grade card, never a verdict", () => {
    expect(move({ criterion: "contract-signed" })).toEqual({
      kind: "surface_grade",
      criterionKey: "contract-signed",
    });
  });

  it("a machine-checked criterion: its own check again", () => {
    expect(move({ criterion: "tests-pass" })).toEqual({
      kind: "recheck_criterion",
      criterionKey: "tests-pass",
    });
  });

  it("a judge criterion: nothing (it re-grades on its own schedule)", () => {
    expect(move({ criterion: "copy-is-clear" })).toBeNull();
  });

  it("an output: its claim against its evidence again", () => {
    expect(move({ output: "signed-contract" })).toEqual({
      kind: "recheck_output",
      outputKey: "signed-contract",
    });
  });

  it("a refusal, no target, an unknown criterion, a stage or two things: nothing", () => {
    expect(
      move({ criterion: "contract-signed" }, { type: "declined", reason: "no" })
    ).toBeNull();
    expect(move(undefined)).toBeNull();
    expect(move("contract-signed")).toBeNull();
    expect(move({ criterion: "no-such" })).toBeNull();
    expect(move({ stage: "review" })).toBeNull();
    expect(move({ criterion: "tests-pass", output: "deploy" })).toBeNull();
    expect(move({ output: "  " })).toBeNull();
  });
});

function event(action: string, data: Record<string, unknown>) {
  return {
    subjectType: "focus_session",
    action,
    subjectId: SESSION,
    userId: OWNER,
    workspaceId: "ws",
    data: {
      sessionId: SESSION,
      expectedLabel: "Sign the contract",
      value: { type: "text" },
      askSnapshot: { mode: "act" },
      ...data,
    },
  };
}
const answered = (data: Record<string, unknown>) =>
  event("slot_answered", data);

const SESSION_ROW = {
  id: SESSION,
  userId: OWNER,
  criteria: [HUMAN_CRITERION, EVIDENCE_CRITERION],
};

async function run(payload: ReturnType<typeof event>) {
  queue.push([SESSION_ROW]);
  await sessionUnblockNotifyReactor.handler(payload as never, {} as never);
}

describe("the reactor re-checks what the answer named, never deciding for the person", () => {
  beforeEach(() => {
    for (const m of [
      surfaceMock,
      recheckMock,
      evidenceMock,
      gradeMock,
      attestMock,
    ])
      m.mockClear();
    queue.length = 0;
  });

  // Whatever the target: the grade and attest doors are never reached.
  afterEach(() => {
    expect(gradeMock).not.toHaveBeenCalled();
    expect(attestMock).not.toHaveBeenCalled();
  });

  it('matches an answer or an "I did this" that names a target, and only those', () => {
    const named = { unblocksTarget: { criterion: "contract-signed" } };
    expect(sessionUnblockNotifyReactor.match!(answered(named) as never)).toBe(
      true
    );
    expect(
      sessionUnblockNotifyReactor.match!(event("slot_attested", named) as never)
    ).toBe(true);
    expect(sessionUnblockNotifyReactor.match!(answered({}) as never)).toBe(
      false
    );
  });

  it("a human criterion target: the grade card is surfaced", async () => {
    await run(answered({ unblocksTarget: { criterion: "contract-signed" } }));
    expect(surfaceMock).toHaveBeenCalledWith(SESSION);
  });

  it("a machine criterion target: its own check runs again, as the owner", async () => {
    await run(answered({ unblocksTarget: { criterion: "tests-pass" } }));
    expect(recheckMock.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      userId: OWNER,
      agentUserId: null,
      criterionKeys: ["tests-pass"],
    });
  });

  it('an output target, from an "I did this": its claim is read against its evidence', async () => {
    await run(
      event("slot_attested", { unblocksTarget: { output: "signed-contract" } })
    );
    expect(evidenceMock.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      userId: OWNER,
    });
  });

  it("a refusal re-checks nothing", async () => {
    await run(
      answered({
        unblocksTarget: { criterion: "tests-pass" },
        value: { type: "declined", reason: "not now" },
      })
    );
    expect(recheckMock).not.toHaveBeenCalled();
    expect(surfaceMock).not.toHaveBeenCalled();
  });
});
