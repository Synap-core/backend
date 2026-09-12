/**
 * The automation `session_update` output advances a stage through the ONE door.
 *
 * THE DEFECT THIS PINS: this step wrote `focus_sessions.current_stage` with a raw
 * UPDATE and a hand-copied `stage_changed` emit, and resolved NO stage gate. A
 * playbook stage declaring `gate: { kind: "human" }` could therefore be entered
 * by an automation with nobody asked and nothing filed — the approval existed in
 * the definition and nowhere in the code path.
 *
 * `@synap/api` depends on `@synap/jobs`, so the door is reached through the
 * `registerStageAdvancer` IoC slot that apps/api fills at boot — the same
 * inversion `registerSessionCloser` uses. What is pinned:
 *
 *   • the step calls the door with `stageWrite: "door"` and the from/to stages,
 *   • the step no longer writes `currentStage` in its OWN update payload,
 *   • an UNREGISTERED slot FAILS the step rather than advancing ungated,
 *   • a patch that does not move the stage never reaches the door.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OWNER = "user-owner";
const WORKSPACE = "ws-1";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  emitSideEffects: vi.fn(),
  /** Every `db.update(focus_sessions).set()` payload the STEP itself writes. */
  sets: [] as Array<Record<string, unknown>>,
  sessionRow: undefined as Record<string, unknown> | undefined,
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
  return { ...actual, emitSideEffects: mocks.emitSideEffects };
});

vi.mock("../../utils/automation-governance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../utils/automation-governance.js")
    >();
  return { ...actual, checkAutomationWriteOrPropose: mocks.gate };
});

const { executeOutputStep } = await import("../automation-executor.js");
const { registerStageAdvancer, advanceSessionStageViaSlot } =
  await import("../../utils/stage-advance.js");

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sets.length = 0;
  mocks.gate.mockResolvedValue({ allowed: true });
  mocks.emitSideEffects.mockResolvedValue(undefined);
  mocks.sessionRow = {
    id: SESSION,
    userId: OWNER,
    workspaceId: WORKSPACE,
    projectId: null,
    channelId: null,
    playbookId: null,
    subjectEntityId: null,
    currentStage: "draft",
    status: "active",
    metadata: null,
    expectedOutputs: [],
  };
  // Default: the slot is FILLED, as apps/api fills it at boot.
  registerStageAdvancer(async () => ({
    changed: true,
    gated: false,
    paused: false,
  }));
});

describe("session_update routes the stage advance through the ONE door", () => {
  it("calls the door with stageWrite:'door' and the real from/to stages", async () => {
    const seen: Array<Record<string, unknown>> = [];
    registerStageAdvancer(async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return { changed: true, gated: false, paused: false };
    });

    const result = await run({ sessionId: SESSION, currentStage: "review" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toStage: "review",
      userId: OWNER,
      stageWrite: "door",
    });
    expect((seen[0].session as { currentStage: string }).currentStage).toBe(
      "draft"
    );
    expect(result).toMatchObject({ status: "updated", stageChanged: true });
  });

  it("does NOT write currentStage in its own update payload any more", async () => {
    await run({ sessionId: SESSION, currentStage: "review" });
    // The step still writes (updatedAt, and any metadata/outputs patch), but the
    // stage column belongs to the door — two writers is how the gate got walked.
    for (const patch of mocks.sets) {
      expect(patch).not.toHaveProperty("currentStage");
    }
  });

  it("reports stageGated when the door pauses the run on a human gate", async () => {
    registerStageAdvancer(async () => ({
      changed: true,
      gated: true,
      paused: true,
      proposalId: "prop-1",
    }));
    const result = await run({ sessionId: SESSION, currentStage: "review" });
    expect(result).toMatchObject({ stageGated: true });
  });

  it("an UNCHANGED stage never reaches the door", async () => {
    const seen: unknown[] = [];
    registerStageAdvancer(async (input) => {
      seen.push(input);
      return { changed: false, gated: false, paused: false };
    });
    await run({ sessionId: SESSION, currentStage: "draft" });
    expect(seen).toEqual([]);
  });

  it("a patch with no stage at all never reaches the door", async () => {
    const seen: unknown[] = [];
    registerStageAdvancer(async (input) => {
      seen.push(input);
      return { changed: false, gated: false, paused: false };
    });
    await run({ sessionId: SESSION, grantStatus: { x: 1 } });
    expect(seen).toEqual([]);
  });
});

describe("the slot is FAIL-CLOSED", () => {
  it("throws when unregistered rather than advancing past an unresolved gate", async () => {
    // A SECOND module instance (vi.resetModules + a plain dynamic import, the
    // house pattern; a `?query` import is not resolvable by tsc) starts with the
    // slot empty, which is the real boot-failure shape. Registering a thrower
    // would prove nothing about the guard clause; this drives the clause itself.
    vi.resetModules();
    const fresh = await import("../../utils/stage-advance.js");
    await expect(
      fresh.advanceSessionStageViaSlot({
        session: {
          id: SESSION,
          currentStage: "draft",
          workspaceId: null,
          projectId: null,
          channelId: null,
          playbookId: null,
          subjectEntityId: null,
        },
        toStage: "review",
        userId: OWNER,
        stageWrite: "door",
      })
    ).rejects.toThrow(/stage advancer unregistered/);
  });

  it("a REGISTERED slot forwards the request verbatim", async () => {
    const seen: unknown[] = [];
    registerStageAdvancer(async (input) => {
      seen.push(input);
      return { changed: true, gated: false, paused: false };
    });
    const out = await advanceSessionStageViaSlot({
      session: {
        id: SESSION,
        currentStage: "draft",
        workspaceId: null,
        projectId: null,
        channelId: null,
        playbookId: null,
        subjectEntityId: null,
      },
      toStage: "review",
      userId: OWNER,
      stageWrite: "door",
    });
    expect(seen).toHaveLength(1);
    expect(out).toMatchObject({ changed: true });
  });
});
