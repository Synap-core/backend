/**
 * The automation session OUTCOME verbs (plan v5 T2, decision V4):
 * `complete_outcome`, `post_evidence`, `reevaluate_criterion`.
 *
 * What is pinned, for each verb:
 *   • it is GOVERNED: the automation gate is asked about a `focus_session`
 *     update carrying the exact patch, with the producer agent;
 *   • a PROPOSAL writes nothing (the door is never reached);
 *   • a DENIAL is a policy block, never a write;
 *   • a GRANT reaches the api door through the slot, on the session's owner;
 *   • an UNREGISTERED slot fails the step (fail-closed);
 *   • the owner + workspace floors refuse another person's / space's session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OWNER = "user-owner";
const WORKSPACE = "ws-1";
const PRODUCER = "agent-ci";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  sessionRow: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const db = {
    query: {
      focusSessions: { findFirst: async () => mocks.sessionRow },
      channels: { findFirst: async () => undefined },
    },
    update: () => ({ set: () => ({ where: async () => [] }) }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  };
  return { ...actual, db };
});

vi.mock("../../utils/automation-governance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../utils/automation-governance.js")
    >();
  return { ...actual, checkAutomationWriteOrPropose: mocks.gate };
});

const { executeOutputStep } = await import("../automation-executor.js");
const { readPostedEvidence } = await import("../steps/output.js");
const { registerSessionOutcomeDoor, resetSessionOutcomeDoorForTests } =
  await import("../../utils/session-outcome-door.js");

const door = {
  completeOutcome: vi.fn(async () => ({ result: "completed" as const })),
  postEvidence: vi.fn(async () => ({
    status: "evaluated" as const,
    recorded: 1,
    skipped: 0,
  })),
  reevaluateCriteria: vi.fn(async () => ({
    status: "evaluated" as const,
    recorded: 2,
    skipped: 0,
  })),
};

const context = (): StepContext => ({
  trigger: { payload: {}, subject: null },
  steps: {},
  automation: { id: "auto-1", state: {} },
});

const run = (outputType: string, config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType, config },
    context(),
    WORKSPACE,
    {
      automationRunId: "run-1",
      automationId: "auto-1",
      chainDepth: 0,
      rootRunId: "run-1",
      chainAutomationIds: [] as string[],
    },
    OWNER,
    OWNER,
    { nodeId: "node-1", stepRunId: "sr-1" },
    null,
    PRODUCER
  );

const CASES = [
  {
    verb: "complete_outcome",
    config: { sessionId: SESSION, outcomeKey: "pr-backend-255" },
    patch: { completeOutput: "pr-backend-255" },
    reached: () => door.completeOutcome,
    call: { sessionId: SESSION, userId: OWNER, outcomeKey: "pr-backend-255" },
  },
  {
    verb: "post_evidence",
    config: {
      sessionId: SESSION,
      evidence: { "ci-green": { passed: "true", detail: "CI passed" } },
    },
    patch: { evidence: { "ci-green": { passed: true, detail: "CI passed" } } },
    reached: () => door.postEvidence,
    call: {
      sessionId: SESSION,
      userId: OWNER,
      agentUserId: PRODUCER,
      evidence: { "ci-green": { passed: true, detail: "CI passed" } },
    },
  },
  {
    verb: "reevaluate_criterion",
    config: { sessionId: SESSION, criterionKeys: ["merged", "deployed"] },
    patch: { reevaluateCriteria: ["merged", "deployed"] },
    reached: () => door.reevaluateCriteria,
    call: {
      sessionId: SESSION,
      userId: OWNER,
      agentUserId: PRODUCER,
      criterionKeys: ["merged", "deployed"],
    },
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({ granted: true });
  mocks.sessionRow = {
    id: SESSION,
    userId: OWNER,
    workspaceId: WORKSPACE,
    status: "active",
    subjectEntityId: null,
  };
  registerSessionOutcomeDoor(door);
});

describe.each(CASES)("$verb", (c) => {
  it("is governed: the gate is asked about this exact patch, with the producer", async () => {
    await run(c.verb, { ...c.config });
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.gate.mock.calls[0]![0]).toMatchObject({
      ownerId: OWNER,
      workspaceId: WORKSPACE,
      subjectType: "focus_session",
      action: "update",
      data: { id: SESSION, ...c.patch },
      producerAgentUserId: PRODUCER,
    });
  });

  it("a GRANT reaches the api door on the session's owner", async () => {
    const r = await run(c.verb, { ...c.config });
    expect(c.reached()).toHaveBeenCalledWith(c.call);
    expect(r).toMatchObject({ sessionId: SESSION });
  });

  it("a PROPOSAL writes nothing", async () => {
    mocks.gate.mockResolvedValue({ proposed: true, proposalId: "prop-1" });
    const r = await run(c.verb, { ...c.config });
    expect(r).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(c.reached()).not.toHaveBeenCalled();
  });

  it("a DENIAL is a policy block, never a write", async () => {
    mocks.gate.mockResolvedValue({ denied: true, reason: "no" });
    await expect(run(c.verb, { ...c.config })).rejects.toThrow(
      /denied by governance/
    );
    expect(c.reached()).not.toHaveBeenCalled();
  });

  it("an unregistered door fails the step (never a silent success)", async () => {
    resetSessionOutcomeDoorForTests();
    await expect(run(c.verb, { ...c.config })).rejects.toThrow(
      /outcome door unregistered/
    );
  });

  it("refuses another person's session", async () => {
    mocks.sessionRow = { ...mocks.sessionRow, userId: "someone-else" };
    await expect(run(c.verb, { ...c.config })).rejects.toThrow(
      /not the automation owner's/
    );
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("refuses a session in another space", async () => {
    mocks.sessionRow = { ...mocks.sessionRow, workspaceId: "ws-other" };
    await expect(run(c.verb, { ...c.config })).rejects.toThrow(
      /not visible in workspace/
    );
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("skips when no session matches", async () => {
    mocks.sessionRow = undefined;
    expect(await run(c.verb, { ...c.config })).toEqual({
      status: "skipped",
      reason: "no matching session",
    });
  });
});

describe("config is validated before governance", () => {
  it.each([
    ["complete_outcome", { sessionId: SESSION }],
    [
      "post_evidence",
      { sessionId: SESSION, evidence: { k: { passed: "maybe" } } },
    ],
    ["reevaluate_criterion", { sessionId: SESSION, criterionKeys: [] }],
  ])("%s with a bad config throws and asks nobody", async (verb, config) => {
    await expect(run(verb, config)).rejects.toThrow();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("readPostedEvidence never reads an unknown value as passed", () => {
    expect(readPostedEvidence({ k: { passed: "false" } })).toEqual({
      k: { passed: false },
    });
    expect(readPostedEvidence({ k: { passed: 1 } })).toBeNull();
    expect(readPostedEvidence({})).toBeNull();
    expect(readPostedEvidence(null)).toBeNull();
  });
});
