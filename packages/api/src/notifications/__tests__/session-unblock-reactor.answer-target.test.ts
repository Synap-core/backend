/**
 * W5 (work model): an answer moves what its slot NAMES (`unblocksTarget`,
 * `SlotUnblocksTarget`) — the rule (`answerTargetMove`, pure) and the reactor
 * that runs it on `focus_session.slot_answered` through the existing doors
 * (the grade door, the attest door, the check gate's resume). Those doors are
 * mocked: what is under test is which one the answer reaches, with what.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { gradeMock, attestMock, resumeMock, queue } = vi.hoisted(() => ({
  gradeMock: vi.fn(async (_p: unknown) => ({
    verdict: "pass",
    recorded: true,
    resumed: false,
  })),
  attestMock: vi.fn(async (_p: unknown) => ({ status: "attested" })),
  resumeMock: vi.fn(async (_p: unknown) => false),
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
  "../../services/focus-sessions/evaluations/evaluate.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    gradeCriterionAfterAct: gradeMock,
    resumeCheckGateIfMet: resumeMock,
  })
);

vi.mock(
  "../../services/focus-sessions/satisfy-expected-output.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    attestExpectedOutput: attestMock,
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
const OUTPUTS = [
  { key: "signed-contract", label: "Signed contract", owner: "human" },
  { key: "deploy", label: "Deploy", owner: "agent" },
  {
    key: "done-thing",
    label: "Done thing",
    owner: "human",
    status: "done",
  },
];

const move = (
  target: unknown,
  askMode: unknown = "act",
  value: unknown = { type: "text" }
) =>
  answerTargetMove({
    target,
    value,
    askMode,
    criteria: [HUMAN_CRITERION, EVIDENCE_CRITERION],
    outputs: OUTPUTS,
  });

describe("answerTargetMove — what an answer moves", () => {
  it("a criterion the person grades, met by their deed: graded", () => {
    expect(move({ criterion: "contract-signed" })).toEqual({
      kind: "grade",
      criterionKey: "contract-signed",
    });
    expect(move({ criterion: "contract-signed" }, "provide")).toEqual({
      kind: "grade",
      criterionKey: "contract-signed",
    });
  });

  it("words, a choice or a machine check grade nothing", () => {
    expect(move({ criterion: "contract-signed" }, "confirm")).toBeNull();
    expect(move({ criterion: "contract-signed" }, "choose")).toBeNull();
    expect(move({ criterion: "contract-signed" }, undefined)).toBeNull();
    expect(move({ criterion: "tests-pass" })).toBeNull();
    expect(move({ criterion: "no-such" })).toBeNull();
  });

  it("an output the person owes is attested; the agent's or a done one is not", () => {
    expect(move({ output: "signed-contract" })).toEqual({
      kind: "attest",
      outputLabel: "Signed contract",
    });
    expect(move({ output: "deploy" })).toBeNull();
    expect(move({ output: "done-thing" })).toBeNull();
    expect(move({ output: "no-such" })).toBeNull();
  });

  it("a stage is checked again", () => {
    expect(move({ stage: "review" })).toEqual({
      kind: "check_stage",
      stageKey: "review",
    });
  });

  it("a refusal, no target, or a target naming two things moves nothing", () => {
    expect(
      move({ criterion: "contract-signed" }, "act", {
        type: "declined",
        reason: "no",
      })
    ).toBeNull();
    expect(move(undefined)).toBeNull();
    expect(move("contract-signed")).toBeNull();
    expect(move({ stage: "review", output: "deploy" })).toBeNull();
    expect(move({ stage: "  " })).toBeNull();
  });
});

function answered(data: Record<string, unknown>) {
  return {
    subjectType: "focus_session",
    action: "slot_answered",
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

const SESSION_ROW = {
  id: SESSION,
  userId: OWNER,
  criteria: [HUMAN_CRITERION, EVIDENCE_CRITERION],
  expectedOutputs: OUTPUTS,
};

describe("the reactor moves what the answer named, through the existing doors", () => {
  beforeEach(() => {
    gradeMock.mockClear();
    attestMock.mockClear();
    resumeMock.mockClear();
    queue.length = 0;
  });

  it("matches an answer that names a target, and only that answer", () => {
    expect(
      sessionUnblockNotifyReactor.match(
        answered({ unblocksTarget: { criterion: "contract-signed" } }) as never
      )
    ).toBe(true);
    expect(sessionUnblockNotifyReactor.match(answered({}) as never)).toBe(
      false
    );
  });

  it("a criterion target: graded pass through the grade door, as the owner", async () => {
    queue.push([SESSION_ROW]);
    await sessionUnblockNotifyReactor.handler(
      answered({ unblocksTarget: { criterion: "contract-signed" } }) as never
    );
    expect(gradeMock).toHaveBeenCalledTimes(1);
    expect(gradeMock.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      userId: OWNER,
      criterionKey: "contract-signed",
      verdict: "pass",
    });
    expect(attestMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("an output target: attested through the attest door", async () => {
    queue.push([SESSION_ROW]);
    await sessionUnblockNotifyReactor.handler(
      answered({ unblocksTarget: { output: "signed-contract" } }) as never
    );
    expect(attestMock).toHaveBeenCalledTimes(1);
    expect(attestMock.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      userId: OWNER,
      expectedLabel: "Signed contract",
    });
    expect(gradeMock).not.toHaveBeenCalled();
  });

  it("a stage target: that stage's check gate is checked again", async () => {
    queue.push([SESSION_ROW]);
    await sessionUnblockNotifyReactor.handler(
      answered({ unblocksTarget: { stage: "review" } }) as never
    );
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      userId: OWNER,
      onlyStage: "review",
    });
  });

  it("a refusal moves nothing", async () => {
    queue.push([SESSION_ROW]);
    await sessionUnblockNotifyReactor.handler(
      answered({
        unblocksTarget: { criterion: "contract-signed" },
        value: { type: "declined", reason: "not now" },
      }) as never
    );
    expect(gradeMock).not.toHaveBeenCalled();
    expect(attestMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });
});
