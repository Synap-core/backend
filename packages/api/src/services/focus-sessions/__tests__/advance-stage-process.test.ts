/**
 * The ONE advance door's process hooks:
 *  - an ungated / passing advance writes the entered stage's subjectStatus
 *    (`writeStageSubjectStatus`) and reports it;
 *  - a HUMAN gate holds that write (the approval does it);
 *  - a HOLDING check gate on a stage that declares `onFail` returns the run to
 *    that stage — un-paused, through the same door, never re-routed again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gates: [] as unknown[],
  writes: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  proc: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
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
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../playbooks/stage-gate.js", () => ({
  applyStageGateOnAdvance: async () => h.gates.shift() ?? null,
}));
vi.mock("../stage-subject-status.js", () => ({
  writeStageSubjectStatus: async (input: Record<string, unknown>) => {
    h.writes.push(input);
    return { status: "written", property: "post-status", value: "x" };
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
  h.proc = {
    stages: [
      { key: "draft", name: "Draft", subjectStatus: "drafting" },
      { key: "review", name: "Review", subjectStatus: "in-review", onFail: { toStage: "Draft" } },
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
      expect.objectContaining({ toStage: "review", userId: "owner-1", agentUserId: "agent-1" }),
    ]);
    expect(r.subjectStatus).toMatchObject({ status: "written" });
  });

  it("a held HUMAN gate does not write the status (the approval will)", async () => {
    h.gates.push({ kind: "human", paused: true, proposalId: "p", proposalType: "playbook.stage_gate", stageKey: "review" });
    await advanceSessionStage({ session: SESSION, toStage: "review", userId: "u", stageWrite: "door" });
    expect(h.writes).toEqual([]);
  });

  it("a HOLDING check gate with onFail returns the run there, un-paused, once", async () => {
    h.gates.push({ kind: "check", stageKey: "review", passed: false, failing: ["k"], paused: true });
    const r = await advanceSessionStage({
      session: SESSION,
      toStage: "review",
      userId: "u",
      stageWrite: "door",
    });
    // onFail.toStage "Draft" resolved by NAME to the key "draft".
    expect(r.onFail).toEqual({ toStage: "draft" });
    // un-pause, then the door's own column write to the onFail stage.
    expect(h.updates).toContainEqual(expect.objectContaining({ status: "active" }));
    expect(h.updates).toContainEqual(expect.objectContaining({ currentStage: "draft" }));
    // The return advance wrote draft's status (ungated); review's never was.
    expect(h.writes.map((w) => w.toStage)).toEqual(["draft"]);
  });

  it("a holding check gate WITHOUT onFail just holds (today's behaviour)", async () => {
    (h.proc as { stages: Array<Record<string, unknown>> }).stages[1]!.onFail = undefined;
    h.gates.push({ kind: "check", stageKey: "review", passed: false, failing: ["k"], paused: true });
    const r = await advanceSessionStage({ session: SESSION, toStage: "review", userId: "u", stageWrite: "door" });
    expect(r.onFail).toBeUndefined();
    expect(h.updates.some((u) => u.status === "active")).toBe(false);
  });
});
