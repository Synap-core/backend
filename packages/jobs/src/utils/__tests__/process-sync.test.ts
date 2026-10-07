/**
 * PROCESS SYNC — the reverse half of stage ↔ subject status, and onFail after
 * a rejected human gate. The ONE advance door is the IoC slot; it is replaced
 * by a recorder (the door has its own suites). The event payloads are the
 * shapes the emitters produce: `entity.update.completed` with flat
 * `changed.<k>` / `<k>` / `previous.<k>` keys (routers/entities/mutate.ts), and
 * `proposal.rejected.completed` with the proposal id as subject.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  proposal: null as Record<string, unknown> | null,
  proc: null as unknown,
  advances: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  T: { focusSessions: { __t: "fs" }, proposals: { __t: "p" } },
}));

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: (t: { __t: string }) => {
        const rows = () =>
          t.__t === "p" ? (h.proposal ? [h.proposal] : []) : h.sessions;
        const q = {
          where: () => q,
          limit: async () => rows(),
          then: (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res),
        };
        return q;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        h.updates.push(v);
        return { where: () => ({ returning: async () => [{ id: "s" }] }) };
      },
    }),
  },
  focusSessions: h.T.focusSessions,
  proposals: h.T.proposals,
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
  isNotNull: () => ({}),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../stage-advance.js", () => ({
  advanceSessionStageViaSlot: async (input: Record<string, unknown>) => {
    h.advances.push(input);
    return { changed: true, gated: false, paused: false };
  },
}));
vi.mock("../session-process.js", () => ({
  loadSessionProcess: async () => h.proc,
}));

import { syncProcessOnEvent } from "../process-sync.js";

const STAGES = [
  { key: "idea", name: "Idea" },
  { key: "draft", name: "Draft", subjectStatus: "drafting" },
  { key: "publish", name: "Publish", subjectStatus: "published", onFail: { toStage: "draft" } },
];
const session = (currentStage: string, extra: Record<string, unknown> = {}) => ({
  id: "sess-1",
  userId: "owner-1",
  currentStage,
  workspaceId: "ws-1",
  projectId: null,
  channelId: null,
  playbookId: "pb-1",
  subjectEntityId: "post-1",
  status: "active",
  ...extra,
});
const statusEvent = (value: string, previous: string) => ({
  eventType: "entity.update.completed",
  subjectId: "post-1",
  userId: "owner-1",
  workspaceId: "ws-1",
  data: {
    profileSlug: "post",
    changedKeys: ["post-status"],
    "changed.post-status": true,
    "previous.post-status": previous,
    "post-status": value,
  },
});

beforeEach(() => {
  h.sessions = [];
  h.proposal = null;
  h.advances = [];
  h.updates = [];
  h.proc = { stages: STAGES, statusProperty: "post-status", humanOnlyStatuses: ["idea"] };
});

describe("subject status → run stage", () => {
  it("advances an open run on that subject to the stage declaring the new status, via the ONE door", async () => {
    h.sessions = [session("draft")];
    const out = await syncProcessOnEvent(statusEvent("published", "drafting"));
    expect(h.advances).toEqual([
      expect.objectContaining({ toStage: "publish", userId: "owner-1", stageWrite: "door" }),
    ]);
    expect(out[0]).toMatchObject({ kind: "followed", backward: false, toStage: "publish" });
  });

  it("LOOP GUARD: a run already at the mapped stage is not advanced", async () => {
    h.sessions = [session("publish")];
    await syncProcessOnEvent(statusEvent("published", "drafting"));
    expect(h.advances).toEqual([]);
  });

  it("a status no stage covers (human-only 'idea') moves nothing", async () => {
    h.sessions = [session("draft")];
    await syncProcessOnEvent(statusEvent("idea", "drafting"));
    expect(h.advances).toEqual([]);
  });

  it("an edit that did not change the status property moves nothing", async () => {
    h.sessions = [session("draft")];
    await syncProcessOnEvent({
      ...statusEvent("published", "drafting"),
      data: { changedKeys: ["title"], title: "x", "post-status": "published" },
    });
    expect(h.advances).toEqual([]);
  });

  it("BACKWARDS is followed (the door allows it) and reported as such", async () => {
    h.sessions = [session("publish")];
    const out = await syncProcessOnEvent(statusEvent("drafting", "published"));
    expect(h.advances[0]).toMatchObject({ toStage: "draft" });
    expect(out[0]).toMatchObject({ kind: "followed", backward: true });
  });
});

describe("rejected human gate → onFail", () => {
  it("un-pauses and returns the held run to its stage's onFail", async () => {
    h.proposal = {
      targetType: "focus_session",
      targetId: "sess-1",
      proposalType: "playbook.stage_gate",
      data: { sessionId: "sess-1", stageKey: "publish" },
    };
    h.sessions = [session("publish", { status: "paused" })];
    const out = await syncProcessOnEvent({
      eventType: "proposal.rejected.completed",
      subjectId: "prop-1",
      userId: "owner-1",
      workspaceId: "ws-1",
      data: { proposalStatus: "rejected" },
    });
    expect(h.updates).toEqual([expect.objectContaining({ status: "active" })]);
    expect(h.advances).toEqual([expect.objectContaining({ toStage: "draft" })]);
    expect(out).toEqual([
      { kind: "on_fail", sessionId: "sess-1", fromStage: "publish", toStage: "draft" },
    ]);
  });

  it("a gate on a stage WITHOUT onFail leaves the run paused (today's behaviour)", async () => {
    h.proposal = {
      targetType: "focus_session",
      targetId: "sess-1",
      proposalType: "playbook.stage_gate",
      data: { stageKey: "draft" },
    };
    h.sessions = [session("draft", { status: "paused" })];
    await syncProcessOnEvent({
      eventType: "proposal.rejected.completed",
      subjectId: "prop-1",
      userId: "owner-1",
      data: {},
    });
    expect(h.updates).toEqual([]);
    expect(h.advances).toEqual([]);
  });
});
