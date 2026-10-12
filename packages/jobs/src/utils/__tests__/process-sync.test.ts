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
  /** A role's CURRENT status (the facet row). */
  facetStatus: null as string | null,
  /** user id → user_type, for the producer's agent-ness. */
  userTypes: {} as Record<string, string>,
  lastUserLookup: null as string | null,
  /** In-flight sessions holding the moved thing as an open worker target. */
  targets: [] as Array<{
    sessionId: string;
    channelId: string | null;
    workerProfileSlug?: string | null;
  }>,
  /** The result writer: first verdict wins, keyed session:entity. */
  stamps: new Map<string, Record<string, unknown>>(),
  posts: [] as Array<Record<string, unknown>>,
  released: [] as string[],
  T: {
    focusSessions: { __t: "fs" },
    proposals: { __t: "p" },
    entities: { __t: "e" },
    entityFacets: { __t: "f" },
    users: { __t: "u", id: "users.id" },
  },
}));

vi.mock("../worker-backlog-release.js", () => ({
  workerAutomationOfProposal: vi.fn(async (id: string) =>
    id === "p-worker" ? "auto-w" : null
  ),
  releaseHeldWorkerRuns: vi.fn(async (a: string) => {
    h.released.push(a);
    return ["run-r"];
  }),
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
              : t.__t === "f"
                ? [{ status: h.facetStatus }]
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
  entityFacets: h.T.entityFacets,
  users: h.T.users,
  // The users lookup is by id: remember which id was asked for.
  eq: (col: unknown, v: unknown) => {
    if (col === h.T.users.id) h.lastUserLookup = v as string;
    return {};
  },
  and: () => ({}),
  inArray: () => ({}),
  isNotNull: () => ({}),
  listOpenWorkerTargetSessions: async () =>
    h.targets.filter((t) => !h.stamps.has(`${t.sessionId}:post-1`)),
  stampWorkerTargetResult: async (i: Record<string, unknown>) => {
    const key = `${i.sessionId}:${i.entityId}`;
    if (h.stamps.has(key)) return false;
    h.stamps.set(key, i);
    return true;
  },
  insertChannelMessage: async (m: Record<string, unknown>) => {
    h.posts.push(m);
    return { messageId: "m-1", mirrored: false };
  },
}));
vi.mock("@synap/events", () => ({
  DUAL_EMIT_ENTITY_UPDATE_FOR_TRANSITIONS: true,
  LIFECYCLE_TRANSITION_EVENT_TYPE: "entity.transition.completed",
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
  h.facetStatus = null;
  h.subjectWrites = [];
  h.userTypes = { "agent-1": "agent", "human-2": "human" };
  h.lastUserLookup = null;
  h.sessions = [];
  h.proposal = null;
  h.advances = [];
  h.updates = [];
  h.targets = [];
  h.stamps = new Map();
  h.posts = [];
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

describe("the transition event (work model L2) → run stage", () => {
  const transition = (extra: Record<string, unknown>) => ({
    eventType: "entity.transition.completed",
    subjectId: "post-1",
    userId: "owner-1",
    workspaceId: "ws-1",
    data: {
      entityId: "post-1",
      property: "post-status",
      from: "scheduled",
      to: "published",
      ...extra,
    },
  });

  it("a ROLE's transition follows, reading the role's status from its facet", async () => {
    h.sessions = [session("schedule")];
    h.facetStatus = "published";
    const out = await syncProcessOnEvent(
      transition({ role: "lead", facetId: "facet-1" })
    );
    expect(h.advances).toEqual([
      expect.objectContaining({ toStage: "publish", skipSubjectWrite: true }),
    ]);
    expect(out[0]).toMatchObject({ kind: "followed", toStage: "publish" });
  });

  it("a stale role transition (the facet moved on) is ignored", async () => {
    h.sessions = [session("schedule")];
    h.facetStatus = "drafting";
    const out = await syncProcessOnEvent(
      transition({ role: "lead", facetId: "facet-1" })
    );
    expect(h.advances).toEqual([]);
    expect(out[0]).toMatchObject({ kind: "ignored", reason: "stale_event" });
  });

  // R1: two roles of one entity may name their lifecycle property alike. A
  // process follows ITS role's move only.
  it("a run ON the role follows that role's move", async () => {
    h.sessions = [session("schedule")];
    h.facetStatus = "published";
    h.proc = { ...(h.proc as Record<string, unknown>), profileSlug: "lead" };
    const out = await syncProcessOnEvent(
      transition({ role: "lead", facetId: "facet-1" })
    );
    expect(out[0]).toMatchObject({ kind: "followed", toStage: "publish" });
  });

  it("a run on ANOTHER role of the same entity does not follow it", async () => {
    h.sessions = [session("schedule")];
    h.facetStatus = "published";
    h.proc = { ...(h.proc as Record<string, unknown>), profileSlug: "client" };
    const out = await syncProcessOnEvent(
      transition({ role: "lead", facetId: "facet-1" })
    );
    expect(h.advances).toEqual([]);
    expect(out).toEqual([]);
  });

  it("a KIND's transition is left to the dual-emitted update event (no double follow)", async () => {
    h.sessions = [session("schedule")];
    h.subject = { "post-status": "published" };
    const out = await syncProcessOnEvent(transition({ role: null }));
    expect(out).toEqual([]);
    expect(h.advances).toEqual([]);
  });
});

describe("worker targets (work model L4/L5): a move settles the thing in each worker session", () => {
  const move = (extra: Record<string, unknown> = {}) => ({
    eventType: "entity.transition.completed",
    subjectId: "post-1",
    userId: "human-2",
    workspaceId: "ws-1",
    data: {
      transitionId: "tr-1",
      entityId: "post-1",
      property: "post-status",
      from: "scheduled",
      to: "published",
      role: null,
      ...extra,
    },
  });

  it("a PERSON's move ⇒ skipped / moved_by_person, with the transition, and one room line", async () => {
    h.targets = [{ sessionId: "worker-1", channelId: "room-1" }];
    const out = await syncProcessOnEvent(move());
    expect(h.stamps.get("worker-1:post-1")).toMatchObject({
      result: "skipped",
      reason: "moved_by_person",
      transitionEventId: "tr-1",
    });
    expect(out).toContainEqual({
      kind: "target_settled",
      sessionId: "worker-1",
      entityId: "post-1",
      result: "skipped",
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ channelId: "room-1" });
    expect(String(h.posts[0]!.content)).toMatch(/re-plan/);
  });

  it("the WORKER's own move (its sessionId on the transition) ⇒ done, no room line", async () => {
    h.targets = [{ sessionId: "worker-1", channelId: "room-1" }];
    await syncProcessOnEvent(move({ sessionId: "worker-1" }));
    expect(h.stamps.get("worker-1:post-1")).toMatchObject({ result: "done" });
    expect(h.posts).toEqual([]);
  });

  it("ANOTHER session's move is not this worker's: skipped", async () => {
    h.targets = [{ sessionId: "worker-1", channelId: null }];
    await syncProcessOnEvent(move({ sessionId: "other-session" }));
    expect(h.stamps.get("worker-1:post-1")).toMatchObject({
      result: "skipped",
      reason: "moved_by_person",
    });
  });

  /**
   * backend F10: a worker follows ONE lifecycle. Rows rule out: settling on
   * the same thing's OTHER lifecycle (its lead facet moved, the client worker
   * is told to re-plan); a filter that also drops the worker's own lifecycle;
   * a legacy session (no stamp) that no move settles anymore.
   */
  it("a move of ANOTHER lifecycle of the thing settles nothing", async () => {
    h.targets = [
      {
        sessionId: "worker-1",
        channelId: "room-1",
        workerProfileSlug: "client",
      },
    ];
    const out = await syncProcessOnEvent(
      move({ role: "lead", facetId: "facet-1", lifecycleProfile: "lead" })
    );
    expect(h.stamps.size).toBe(0);
    expect(h.posts).toEqual([]);
    expect(out.filter((o) => o.kind === "target_settled")).toEqual([]);
  });

  it("a move of the lifecycle the worker follows settles it", async () => {
    h.targets = [
      { sessionId: "worker-1", channelId: null, workerProfileSlug: "post" },
    ];
    await syncProcessOnEvent(move({ lifecycleProfile: "post" }));
    expect(h.stamps.get("worker-1:post-1")).toMatchObject({
      result: "skipped",
    });
  });

  it("a session started before the stamp (no profile) is settled by any move", async () => {
    h.targets = [
      { sessionId: "worker-1", channelId: null, workerProfileSlug: null },
    ];
    await syncProcessOnEvent(move({ lifecycleProfile: "lead" }));
    expect(h.stamps.get("worker-1:post-1")).toMatchObject({
      result: "skipped",
    });
  });

  it("a REDELIVERED transition neither re-stamps nor re-posts", async () => {
    h.targets = [{ sessionId: "worker-1", channelId: "room-1" }];
    await syncProcessOnEvent(move());
    const again = await syncProcessOnEvent(move());
    expect(h.posts).toHaveLength(1);
    expect(again.filter((o) => o.kind === "target_settled")).toEqual([]);
  });

  it("the subject-follow is untouched: no worker targets ⇒ the transition does what it did", async () => {
    // A KIND's transition is left to the dual-emitted update (see above);
    // the settle half adds nothing when no session targets the thing.
    h.sessions = [session("schedule")];
    const out = await syncProcessOnEvent(move());
    expect(out).toEqual([]);
    expect(h.advances).toEqual([]);
  });
});

/**
 * arch F12: a decided proposal of a worker drains its backlog — the fires it
 * HELD are released (the release itself: worker-backlog-release.pglite).
 */
describe("a decided worker proposal releases the held fires", () => {
  beforeEach(() => {
    h.released = [];
    h.proposal = null;
  });
  for (const eventType of [
    "proposal.approved.completed",
    "proposal.rejected.completed",
  ]) {
    it(`${eventType} of a worker's proposal → release`, async () => {
      const out = await syncProcessOnEvent({
        eventType,
        subjectId: "p-worker",
        userId: "u1",
      });
      expect(h.released).toEqual(["auto-w"]);
      expect(out).toContainEqual({
        kind: "backlog_released",
        automationId: "auto-w",
        runIds: ["run-r"],
      });
    });
  }
  it("a proposal that is not a worker's → nothing", async () => {
    await syncProcessOnEvent({
      eventType: "proposal.approved.completed",
      subjectId: "p-other",
      userId: "u1",
    });
    expect(h.released).toEqual([]);
  });
});
