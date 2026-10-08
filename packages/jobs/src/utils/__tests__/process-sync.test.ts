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
  subjectWrites: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  /** The subject's CURRENT properties (the follow re-reads them). */
  subject: {} as Record<string, unknown>,
  /** user id → user_type, for the producer's agent-ness. */
  userTypes: {} as Record<string, string>,
  lastUserLookup: null as string | null,
  T: {
    focusSessions: { __t: "fs" },
    proposals: { __t: "p" },
    entities: { __t: "e" },
    users: { __t: "u", id: "users.id" },
  },
}));

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: (t: { __t: string }) => {
        const rows = () =>
          t.__t === "p"
            ? h.proposal
              ? [h.proposal]
              : []
            : t.__t === "e"
              ? [{ properties: h.subject }]
              : t.__t === "u"
                ? h.lastUserLookup && h.userTypes[h.lastUserLookup]
                  ? [{ userType: h.userTypes[h.lastUserLookup] }]
                  : []
                : h.sessions;
        const q = {
          where: () => q,
          limit: async () => rows(),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(rows()).then(res),
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
  entities: h.T.entities,
  users: h.T.users,
  // The users lookup is by id: remember which id was asked for.
  eq: (col: unknown, v: unknown) => {
    if (col === h.T.users.id) h.lastUserLookup = v as string;
    return {};
  },
  and: () => ({}),
  inArray: () => ({}),
  isNotNull: () => ({}),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../stage-advance.js", () => ({
  // The door, faithful to the forward write: unless told the advance follows
  // the subject, it writes the entered stage's status onto the subject.
  advanceSessionStageViaSlot: async (input: Record<string, unknown>) => {
    h.advances.push(input);
    const proc = h.proc as { stages: Array<Record<string, unknown>> };
    const st = proc.stages.find((x) => x.key === input.toStage);
    if (!input.skipSubjectWrite && typeof st?.subjectStatus === "string") {
      h.subject = { ...h.subject, "post-status": st.subjectStatus };
      h.subjectWrites.push(st.subjectStatus);
    }
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
  {
    key: "review",
    name: "Review",
    subjectStatus: "review",
    gate: { kind: "human" },
  },
  { key: "schedule", name: "Schedule", subjectStatus: "scheduled" },
  {
    key: "publish",
    name: "Publish",
    subjectStatus: "published",
    onFail: { toStage: "draft" },
  },
];
const session = (
  currentStage: string,
  extra: Record<string, unknown> = {}
) => ({
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
  h.subject = {};
  h.subjectWrites = [];
  h.userTypes = { "agent-1": "agent", "human-2": "human" };
  h.lastUserLookup = null;
  h.sessions = [];
  h.proposal = null;
  h.advances = [];
  h.updates = [];
  h.proc = {
    stages: STAGES,
    statusProperty: "post-status",
    humanOnlyStatuses: ["idea"],
  };
});

/** The subject now holds `value` (the write happened), and its event arrives. */
const entered = (
  value: string,
  previous: string,
  extra: Record<string, unknown> = {}
) => {
  h.subject = { "post-status": value };
  return syncProcessOnEvent({ ...statusEvent(value, previous), ...extra });
};

describe("subject status → run stage", () => {
  it("advances an open run on that subject to the stage declaring the new status, via the ONE door", async () => {
    h.sessions = [session("schedule")];
    const out = await entered("published", "scheduled");
    expect(h.advances).toEqual([
      expect.objectContaining({
        toStage: "publish",
        userId: "owner-1",
        stageWrite: "door",
      }),
    ]);
    expect(out[0]).toMatchObject({
      kind: "followed",
      backward: false,
      toStage: "publish",
    });
  });

  it("a follow NEVER writes the status back (it only moves the run)", async () => {
    h.sessions = [session("draft")];
    await entered("scheduled", "drafting");
    expect(h.advances[0]).toMatchObject({
      toStage: "schedule",
      skipSubjectWrite: true,
    });
    expect(h.subjectWrites).toEqual([]);
  });

  it("LOOP: a rapid B→C sequence ends at C with no further writes (stale B is ignored)", async () => {
    h.sessions = [session("idea")];
    // The person moved the post to drafting, then to scheduled, before either
    // event was processed: the subject already holds `scheduled`.
    h.subject = { "post-status": "scheduled" };
    const first = await syncProcessOnEvent(statusEvent("drafting", "idea"));
    expect(first).toEqual([
      { kind: "ignored", sessionId: "sess-1", reason: "stale_event" },
    ]);
    const second = await syncProcessOnEvent(
      statusEvent("scheduled", "drafting")
    );
    expect(second[0]).toMatchObject({ kind: "followed", toStage: "schedule" });
    expect(h.advances.map((a) => a.toStage)).toEqual(["schedule"]);
    expect(h.subjectWrites).toEqual([]);
    expect(h.subject).toEqual({ "post-status": "scheduled" });
  });

  it("LOOP GUARD: a run already at the mapped stage is not advanced", async () => {
    h.sessions = [session("publish")];
    await entered("published", "scheduled");
    expect(h.advances).toEqual([]);
  });

  it("a status no stage covers (human-only 'idea') moves nothing", async () => {
    h.sessions = [session("draft")];
    await entered("idea", "drafting");
    expect(h.advances).toEqual([]);
  });

  it("an edit that did not change the status property moves nothing", async () => {
    h.sessions = [session("draft")];
    h.subject = { "post-status": "published" };
    await syncProcessOnEvent({
      ...statusEvent("published", "drafting"),
      data: { changedKeys: ["title"], title: "x", "post-status": "published" },
    });
    expect(h.advances).toEqual([]);
  });

  it("BACKWARDS is followed (the door allows it) and reported as such", async () => {
    h.sessions = [session("publish")];
    const out = await entered("drafting", "published");
    expect(h.advances[0]).toMatchObject({ toStage: "draft" });
    expect(out[0]).toMatchObject({ kind: "followed", backward: true });
  });
});

describe("an AGENT's status write never walks a human gate", () => {
  it("a forward jump over a human-gated stage stops AT that stage (the door files its gate), as the agent", async () => {
    h.sessions = [session("draft")];
    const out = await entered("published", "drafting", {
      producerAgentUserId: "agent-1",
    });
    expect(h.advances).toEqual([
      expect.objectContaining({ toStage: "review", agentUserId: "agent-1" }),
    ]);
    expect(out[0]).toMatchObject({
      kind: "followed",
      toStage: "review",
      heldAtGate: "review",
    });
  });

  it("a run HELD at its human gate does not move on an agent's write", async () => {
    h.sessions = [session("review", { status: "paused" })];
    const out = await entered("scheduled", "review", {
      producerAgentUserId: "agent-1",
    });
    expect(h.advances).toEqual([]);
    expect(out).toEqual([
      { kind: "ignored", sessionId: "sess-1", reason: "held_at_human_gate" },
    ]);
  });

  it("a PERSON's own jump is their decision and is followed as written", async () => {
    h.sessions = [session("draft")];
    await entered("published", "drafting", { producerAgentUserId: "human-2" });
    expect(h.advances).toEqual([
      expect.objectContaining({ toStage: "publish", agentUserId: null }),
    ]);
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
      {
        kind: "on_fail",
        sessionId: "sess-1",
        fromStage: "publish",
        toStage: "draft",
      },
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
