/**
 * The ONE advance door refuses a stage the session's process does not declare
 * (finding 8c08b138). Before it, only the MCP door's callers ever saw a key
 * checked; an automation's `session_update` (through the jobs slot) could
 * write `merged` on a session whose playbook has no such stage.
 *
 * What is pinned (each row rules a wrong rule OUT):
 *   - an undeclared key on a staged run: a typed refusal, and NOTHING written,
 *     emitted, gated or moved (a "refuse after the write" rule fails here);
 *   - the same refusal for a `"caller"` door (the floor holds if a door forgot
 *     to ask first);
 *   - a declared key still advances (a "refuse everything" rule fails here);
 *   - a session with NO process, or a process with no stages, keeps its free
 *     label (a "refuse unless declared" rule with no stageless exception fails
 *     here);
 *   - the key it already holds is the no-op it always was.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gates: 0,
  writes: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  proc: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    setSessionStatus: async () => ({ rows: [], transitions: [] }),
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ status: "active" }] }),
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
  applyStageGateOnAdvance: async () => {
    h.gates += 1;
    return null;
  },
}));
vi.mock("../stage-subject-status.js", () => ({
  writeStageSubjectStatus: async (input: Record<string, unknown>) => {
    h.writes.push(input);
    return { status: "skipped", reason: "no_status_property" };
  },
}));
vi.mock("@synap/jobs/utils/session-process.js", () => ({
  loadSessionProcess: async () => h.proc,
}));

import { advanceSessionStage } from "../advance-stage.js";

const SESSION = {
  id: "sess-1",
  currentStage: "fix",
  workspaceId: "ws-1",
  projectId: null,
  channelId: null,
  playbookId: "pb-ship",
  subjectEntityId: null,
};

const STAGED = {
  stages: [
    { key: "fix", name: "Fix it" },
    { key: "merged", name: "Merged" },
    { key: "verified", name: "Verified" },
  ],
  profileSlug: null,
  statusProperty: null,
  humanOnlyStatuses: [],
};

const advance = (toStage: string, stageWrite: "door" | "caller" = "door") =>
  advanceSessionStage({
    session: SESSION,
    toStage,
    userId: "owner-1",
    agentUserId: null,
    stageWrite,
  });

beforeEach(() => {
  h.gates = 0;
  h.writes = [];
  h.updates = [];
  h.emits = [];
  h.proc = STAGED;
});

describe("advanceSessionStage — declared stages only", () => {
  it("refuses a key the process does not declare, writing nothing", async () => {
    const r = await advance("shipped");
    expect(r).toMatchObject({
      changed: false,
      gated: false,
      paused: false,
      refused: {
        code: "UNDECLARED_STAGE",
        stages: ["fix", "merged", "verified"],
      },
    });
    expect(r.refused?.reason).toMatch(/"shipped" is not a stage/);
    expect(h.updates).toEqual([]);
    expect(h.emits).toEqual([]);
    expect(h.gates).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("refuses it for a caller door too (the floor when a door forgot to ask)", async () => {
    const r = await advance("shipped", "caller");
    expect(r.refused?.code).toBe("UNDECLARED_STAGE");
    expect(h.updates).toEqual([]);
    expect(h.emits).toEqual([]);
  });

  it("a declared key advances as before", async () => {
    const r = await advance("merged");
    expect(r.refused).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(h.updates[0]).toMatchObject({ currentStage: "merged" });
    expect(h.emits).toHaveLength(1);
  });

  it("a session with no process keeps its free stage label", async () => {
    h.proc = null;
    const r = await advance("anything-goes");
    expect(r.refused).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(h.updates[0]).toMatchObject({ currentStage: "anything-goes" });
  });

  it("a process with no stages keeps the free label too", async () => {
    h.proc = { ...STAGED, stages: [] };
    const r = await advance("anything-goes");
    expect(r.refused).toBeUndefined();
    expect(r.changed).toBe(true);
  });

  it("the stage it already holds is a no-op, never a refusal", async () => {
    h.proc = { ...STAGED, stages: [{ key: "verified", name: "Verified" }] };
    const r = await advance("fix");
    expect(r).toEqual({ changed: false, gated: false, paused: false });
  });
});
