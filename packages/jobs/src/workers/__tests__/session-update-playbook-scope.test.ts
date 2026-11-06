/**
 * The automation `session_update` verb, scoped and checked (finding 8c08b138):
 *
 *   - `whenPlaybookId` makes the step act ONLY on a session following that
 *     playbook; any other session is a REPORTED no-op decided before
 *     governance (no proposal, no write, no door). Without it "PR merged →
 *     stage merged" moved every session a PR named;
 *   - a stage key the session's process does not declare is REFUSED before
 *     governance, so neither a granted write nor a proposal (applied later by
 *     the executor, outside the advance door) can carry it;
 *   - a session with no stages keeps its free label (reaches the door).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FIX_A_FINDING = "18abd1ea-290e-4bd7-b9e6-97cb5a82477b";
const SHIP_A_CHANGE = "99999999-9999-4999-8999-999999999999";
const OWNER = "user-owner";
const WORKSPACE = "ws-1";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  sets: [] as Array<Record<string, unknown>>,
  sessionRow: undefined as Record<string, unknown> | undefined,
  proc: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const db = {
    query: {
      focusSessions: { findFirst: async () => mocks.sessionRow },
      channels: { findFirst: async () => undefined },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        mocks.sets.push(patch);
        return { where: async () => [] };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  };
  return { ...actual, db };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/events")>();
  return { ...actual, emitSideEffects: vi.fn(async () => undefined) };
});

vi.mock("../../utils/automation-governance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../utils/automation-governance.js")
    >();
  return { ...actual, checkAutomationWriteOrPropose: mocks.gate };
});

vi.mock("../../utils/session-process.js", () => ({
  loadSessionProcess: async () => mocks.proc,
}));

const { executeOutputStep } = await import("../automation-executor.js");
const { registerStageAdvancer } = await import("../../utils/stage-advance.js");

const context = (): StepContext => ({
  trigger: { payload: {}, subject: null },
  steps: {},
  automation: { id: "auto-1", state: {} },
});

const run = (config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType: "session_update", config },
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
    { nodeId: "node-1", stepRunId: "sr-1" }
  );

const doorCalls: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sets.length = 0;
  doorCalls.length = 0;
  mocks.gate.mockResolvedValue({ allowed: true });
  mocks.sessionRow = {
    id: SESSION,
    userId: OWNER,
    workspaceId: WORKSPACE,
    projectId: null,
    channelId: null,
    playbookId: FIX_A_FINDING,
    subjectEntityId: null,
    currentStage: "fix",
    status: "active",
    metadata: null,
    expectedOutputs: [],
  };
  mocks.proc = {
    stages: [
      { key: "fix", name: "Fix it" },
      { key: "merged", name: "Merged" },
      { key: "verified", name: "Verified" },
    ],
    profileSlug: null,
    statusProperty: null,
    humanOnlyStatuses: [],
  };
  registerStageAdvancer(async (input) => {
    doorCalls.push(input);
    return { changed: true, gated: false, paused: false };
  });
});

describe("session_update — whenPlaybookId scopes the step to one playbook's sessions", () => {
  it("a session following ANOTHER playbook is a reported no-op: no governance, no write, no door", async () => {
    mocks.sessionRow!.playbookId = SHIP_A_CHANGE;
    const out = await run({
      sessionId: SESSION,
      currentStage: "merged",
      whenPlaybookId: FIX_A_FINDING,
    });
    expect(out).toMatchObject({
      status: "skipped",
      sessionId: SESSION,
      whenPlaybookId: FIX_A_FINDING,
    });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.sets).toEqual([]);
    expect(doorCalls).toEqual([]);
  });

  it("a session following NO playbook is skipped too", async () => {
    mocks.sessionRow!.playbookId = null;
    const out = await run({
      sessionId: SESSION,
      currentStage: "merged",
      whenPlaybookId: FIX_A_FINDING,
    });
    expect(out).toMatchObject({ status: "skipped" });
    expect(doorCalls).toEqual([]);
  });

  it("a session following THAT playbook advances through the door", async () => {
    const out = await run({
      sessionId: SESSION,
      currentStage: "merged",
      whenPlaybookId: FIX_A_FINDING,
    });
    expect(out).toMatchObject({ status: "updated", stageChanged: true });
    expect(doorCalls).toHaveLength(1);
    expect(doorCalls[0]).toMatchObject({ toStage: "merged" });
  });
});

describe("session_update — declared stages only, before governance", () => {
  it("refuses an undeclared key: no governance, no write, no door", async () => {
    const out = await run({ sessionId: SESSION, currentStage: "shipped" });
    expect(out).toMatchObject({
      status: "refused",
      code: "UNDECLARED_STAGE",
      sessionId: SESSION,
      stages: ["fix", "merged", "verified"],
    });
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.sets).toEqual([]);
    expect(doorCalls).toEqual([]);
  });

  it("a stageless session keeps its free label (reaches the door)", async () => {
    mocks.proc = null;
    mocks.sessionRow!.playbookId = null;
    const out = await run({ sessionId: SESSION, currentStage: "anything" });
    expect(out).toMatchObject({ status: "updated", stageChanged: true });
    expect(doorCalls).toHaveLength(1);
  });

  it("reports the door's own refusal, never a silent 'updated'", async () => {
    registerStageAdvancer(async () => ({
      changed: false,
      gated: false,
      paused: false,
      refused: {
        code: "UNDECLARED_STAGE",
        reason: '"merged" is not a stage of this session\'s process.',
        stages: ["fix"],
      },
    }));
    const out = await run({ sessionId: SESSION, currentStage: "merged" });
    expect(out).toMatchObject({ status: "refused", code: "UNDECLARED_STAGE" });
  });
});
