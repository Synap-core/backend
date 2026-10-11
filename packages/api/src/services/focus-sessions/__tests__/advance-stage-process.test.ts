/**
 * The ONE advance door's process hooks:
 *  - an ungated / passing advance writes the entered stage's subjectStatus
 *    (`writeStageSubjectStatus`) and reports it;
 *  - a HUMAN gate holds that write (the approval does it);
 *  - a HOLDING check gate on a stage that declares `onFail` returns the run to
 *    that stage — un-paused, through the same door, never re-routed again;
 *  - STEP = STATUS: a door advance the subject leads moves the subject and
 *    does NOT write `current_stage` (the follow does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gates: [] as unknown[],
  writes: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  proc: null as unknown,
  /** The session's live status (the subject-first path reads it). */
  sessionStatus: "active" as string,
  /** What the subject write answers. */
  subjectOutcome: {
    status: "written",
    property: "post-status",
    value: "x",
  } as Record<string, unknown>,
  emits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ status: h.sessionStatus }] }),
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          h.updates.push(v);
          return {
            where: () =>
              Object.assign(Promise.resolve([{ id: "sess-1" }]), {
                returning: async () => [{ id: "sess-1" }],
              }),
          };
        },
      }),
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async (e: Record<string, unknown>) => {
    h.emits.push(e);
  }),
}));
vi.mock("../../playbooks/stage-gate.js", () => ({
  applyStageGateOnAdvance: async () => h.gates.shift() ?? null,
}));
vi.mock("../stage-subject-status.js", () => ({
  writeStageSubjectStatus: async (input: Record<string, unknown>) => {
    h.writes.push(input);
    return h.subjectOutcome;
  },
}));
vi.mock("@synap/jobs/utils/session-process.js", () => ({
  loadSessionProcess: async () => h.proc,
}));

import { advanceSessionStage } from "../advance-stage.js";

const SESSION = {
  id: "sess-1",
  currentStage: "draft",
  workspaceId: "ws-1",
  projectId: null,
  channelId: null,
  playbookId: "pb-1",
  subjectEntityId: "post-1",
};

beforeEach(() => {
  h.gates = [];
  h.writes = [];
  h.updates = [];
  h.emits = [];
  h.sessionStatus = "active";
  h.subjectOutcome = { status: "written", property: "post-status", value: "x" };
  h.proc = {
    stages: [
      { key: "draft", name: "Draft", subjectStatus: "drafting" },
      {
        key: "review",
        name: "Review",
        subjectStatus: "in-review",
        onFail: { toStage: "Draft" },
      },
    ],
    statusProperty: "post-status",
    humanOnlyStatuses: [],
  };
});

describe("advanceSessionStage — process hooks", () => {
  it("an ungated advance writes the entered stage's subject status", async () => {
    const r = await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "owner-1",
      agentUserId: "agent-1",
      stageWrite: "door",
    });
    expect(h.writes).toEqual([
      expect.objectContaining({
        toStage: "review",
        userId: "owner-1",
        agentUserId: "agent-1",
      }),
    ]);
    expect(r.subjectStatus).toMatchObject({ status: "written" });
  });

  it("a held HUMAN gate does not write the status (the approval will)", async () => {
    (h.proc as { stages: Array<Record<string, unknown>> }).stages[1]!.gate = {
      kind: "human",
    };
    h.gates.push({
      kind: "human",
      paused: true,
      proposalId: "p",
      proposalType: "playbook.stage_gate",
      stageKey: "review",
    });
    await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "u",
      stageWrite: "door",
    });
    expect(h.writes).toEqual([]);
  });

  it("a HOLDING check gate with onFail returns the run there, un-paused, once", async () => {
    (h.proc as { stages: Array<Record<string, unknown>> }).stages[1]!.gate = {
      kind: "check",
    };
    h.gates.push({
      kind: "check",
      stageKey: "review",
      passed: false,
      failing: ["k"],
      paused: true,
    });
    const r = await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "u",
      stageWrite: "door",
    });
    // onFail.toStage "Draft" resolved by NAME to the key "draft".
    expect(r.onFail).toEqual({ toStage: "draft" });
    // un-pause, then the return advance: the run went INTO "review" (gated,
    // the column written), and "draft" is subject-led (step = status) — the
    // subject moves back to "drafting" and the follow writes the column.
    expect(h.updates).toContainEqual(
      expect.objectContaining({ status: "active" })
    );
    expect(h.updates).toContainEqual(
      expect.objectContaining({ currentStage: "review" })
    );
    expect(h.updates).not.toContainEqual(
      expect.objectContaining({ currentStage: "draft" })
    );
    // The return advance wrote draft's status (ungated); review's never was.
    expect(h.writes.map((w) => w.toStage)).toEqual(["draft"]);
  });

  it("a holding check gate WITHOUT onFail just holds (today's behaviour)", async () => {
    const review = (h.proc as { stages: Array<Record<string, unknown>> })
      .stages[1]!;
    review.onFail = undefined;
    review.gate = { kind: "check" };
    h.gates.push({
      kind: "check",
      stageKey: "review",
      passed: false,
      failing: ["k"],
      paused: true,
    });
    const r = await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "u",
      stageWrite: "door",
    });
    expect(r.onFail).toBeUndefined();
    expect(h.updates.some((u) => u.status === "active")).toBe(false);
  });

  it("a FOLLOW (skipSubjectWrite) moves the run and never writes the status back", async () => {
    const r = await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "owner-1",
      stageWrite: "door",
      skipSubjectWrite: true,
    });
    expect(h.writes).toEqual([]);
    expect(r.subjectStatus).toBeUndefined();
    expect(h.updates).toContainEqual(
      expect.objectContaining({ currentStage: "review" })
    );
  });

  it("a FOLLOW into a PASSING check gate writes nothing either", async () => {
    h.gates.push({
      kind: "check",
      stageKey: "review",
      passed: true,
      failing: [],
      paused: false,
    });
    await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "u",
      stageWrite: "door",
      skipSubjectWrite: true,
    });
    expect(h.writes).toEqual([]);
  });
});

describe("STEP = STATUS — the subject leads, the follow writes the column", () => {
  const advance = (extra: Record<string, unknown> = {}) =>
    advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "owner-1",
      agentUserId: "agent-1",
      stageWrite: "door",
      ...extra,
    });
  const stageWrites = () =>
    h.updates.filter((u) => "currentStage" in u).map((u) => u.currentStage);

  it("an ungated subject-led advance moves the subject and does NOT write current_stage", async () => {
    const r = await advance();
    expect(h.writes.map((w) => w.toStage)).toEqual(["review"]);
    expect(stageWrites()).toEqual([]);
    expect(r).toMatchObject({
      changed: true,
      stageFollowsSubject: true,
      subjectStatus: { status: "written" },
    });
    // Nothing the follow's own advance will do is done twice here.
    expect(h.emits).toEqual([]);
  });

  it("a PROPOSED subject move does not advance the run either (approval will)", async () => {
    h.subjectOutcome = {
      status: "proposed",
      property: "post-status",
      value: "in-review",
      proposalId: "p-1",
    };
    const r = await advance();
    expect(stageWrites()).toEqual([]);
    expect(r.stageFollowsSubject).toBe(true);
  });

  it("the FOLLOW (skipSubjectWrite) is the one that writes the column", async () => {
    await advance({ skipSubjectWrite: true, agentUserId: null });
    expect(h.writes).toEqual([]);
    expect(stageWrites()).toEqual(["review"]);
  });

  it("a subject that ALREADY holds the value: no event will follow, so the column is written (once, no second subject write)", async () => {
    h.subjectOutcome = { status: "skipped", reason: "already_set" };
    const r = await advance();
    expect(stageWrites()).toEqual(["review"]);
    expect(h.writes).toHaveLength(1);
    expect(r.subjectStatus).toEqual({
      status: "skipped",
      reason: "already_set",
    });
    expect(r.stageFollowsSubject).toBeUndefined();
  });

  it("a GATED stage keeps the stage-stands-then-gate path", async () => {
    (h.proc as { stages: Array<Record<string, unknown>> }).stages[1]!.gate = {
      kind: "human",
    };
    h.gates.push({
      kind: "human",
      paused: true,
      proposalId: "p",
      proposalType: "playbook.stage_gate",
      stageKey: "review",
    });
    await advance();
    expect(stageWrites()).toEqual(["review"]);
    expect(h.writes).toEqual([]);
  });

  it("a session the follow would not move (paused) keeps the direct write", async () => {
    h.sessionStatus = "paused";
    await advance();
    expect(stageWrites()).toEqual(["review"]);
  });

  it("the CALLER doors are untouched: they wrote the column themselves", async () => {
    await advance({ stageWrite: "caller" });
    expect(stageWrites()).toEqual([]);
    expect(h.writes.map((w) => w.toStage)).toEqual(["review"]);
    expect(h.emits.length).toBeGreaterThan(0);
  });
});
