/**
 * STAGE → SUBJECT STATUS (the forward half): advancing into a stage that
 * declares `subjectStatus` writes it onto the run's subject through the
 * GOVERNED entity door (`entities.update`), attributed to the agent that drove
 * the advance. Driven against the real `writeStageSubjectStatus`, with the
 * entity door replaced by a recorder — the door's governance has its own suites;
 * what is pinned here is WHAT reaches it, and every skip (incl. the loop guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  proc: null as null | {
    stages: Array<Record<string, unknown>>;
    profileSlug?: string | null;
    statusProperty: string | null;
    humanOnlyStatuses: string[];
  },
  entity: null as null | {
    properties: Record<string, unknown>;
    workspaceId: string;
  },
  update: vi.fn(
    async (_input: Record<string, unknown>) =>
      ({ status: "updated" }) as Record<string, unknown>
  ),
  ctx: [] as Array<Record<string, unknown>>,
  // The status door. Default: the kind declares no lifecycle → the legacy
  // governed entity-update path below runs (what the cases above pin).
  move: vi.fn(
    async (_input: Record<string, unknown>) =>
      ({ status: "refused", code: "NO_LIFECYCLE", reason: "none" }) as Record<
        string,
        unknown
      >
  ),
}));

vi.mock("../../lifecycle/move-status.js", () => ({ moveStatus: h.move }));
// The ONE kind-or-role reader (shared with the activators). Default: a kind.
const subjectProfile = vi.hoisted(() => ({
  read: vi.fn(async (_slug: string, _ws: string | null) => ({
    profileKind: "kind" as "kind" | "role",
    lifecycleProperty: null as string | null,
  })),
}));
vi.mock("../../playbooks/playbook-activators.js", () => ({
  readSubjectProfile: subjectProfile.read,
}));

vi.mock("@synap/jobs/utils/session-process.js", () => ({
  loadSessionProcess: async () => h.proc,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (h.entity ? [h.entity] : []) }),
        }),
      }),
    },
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
});
vi.mock("../../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctx.push(ctx);
      return { update: h.update };
    },
  },
}));

import { writeStageSubjectStatus } from "../stage-subject-status.js";

const SESSION = {
  id: "sess-1",
  playbookId: "pb-1",
  subjectEntityId: "post-1",
  workspaceId: "ws-1",
};
const STAGES = [
  { key: "idea", name: "Idea" },
  { key: "draft", name: "Draft", subjectStatus: "drafting" },
  { key: "publish", name: "Publish", subjectStatus: "published" },
];

beforeEach(() => {
  h.proc = {
    stages: STAGES,
    profileSlug: "post",
    statusProperty: "post-status",
    humanOnlyStatuses: [],
  } as typeof h.proc;
  subjectProfile.read.mockClear();
  subjectProfile.read.mockResolvedValue({
    profileKind: "kind",
    lifecycleProperty: null,
  });
  h.entity = { properties: { "post-status": "idea" }, workspaceId: "ws-1" };
  h.update.mockClear();
  h.update.mockResolvedValue({ status: "updated" });
  h.ctx.length = 0;
  h.move.mockClear();
  h.move.mockResolvedValue({
    status: "refused",
    code: "NO_LIFECYCLE",
    reason: "none",
  });
});

describe("writeStageSubjectStatus — the status door (work model L2)", () => {
  it("when statusProperty IS the declared lifecycle, it MOVES through moveStatus, never entities.update", async () => {
    h.move.mockResolvedValue({ status: "moved", transition: {} });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "draft",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toEqual({
      status: "written",
      property: "post-status",
      value: "drafting",
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.move.mock.calls[0]![0]).toMatchObject({
      entityId: "post-1",
      property: "post-status",
      to: "drafting",
      sessionId: "sess-1",
      actor: { kind: "agent", agentUserId: "agent-1", userId: "owner-1" },
    });
  });

  it("a proposed move is success; a playbook human-only status still forces a proposal", async () => {
    h.proc!.humanOnlyStatuses = ["published"];
    h.move.mockResolvedValue({
      status: "proposed",
      proposalId: "p-1",
      proposalType: "entity.transition",
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "publish",
      userId: "owner-1",
    });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-1" });
    expect(h.move.mock.calls[0]![0]).toMatchObject({ forcePropose: true });
  });

  it("a stale subject is a failed write, never an overwrite", async () => {
    h.move.mockResolvedValue({
      status: "conflict",
      expectedFrom: "idea",
      actual: "published",
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "draft",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out.status).toBe("failed");
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("writeStageSubjectStatus", () => {
  it("writes the stage's subjectStatus through entities.update, as the driving agent, in the session", async () => {
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "draft",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toEqual({
      status: "written",
      property: "post-status",
      value: "drafting",
    });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0]![0]).toMatchObject({
      id: "post-1",
      properties: { "post-status": "drafting" },
      agentUserId: "agent-1",
      source: "agent",
    });
    expect(h.ctx[0]).toMatchObject({ userId: "owner-1", sessionId: "sess-1" });
  });

  it("a PROPOSED write is success, reported with its proposal", async () => {
    h.update.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-9",
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "publish",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toEqual({
      status: "proposed",
      property: "post-status",
      value: "published",
      proposalId: "prop-9",
    });
  });

  it("LOOP GUARD: the subject already holds the value → nothing is written", async () => {
    h.entity = {
      properties: { "post-status": "drafting" },
      workspaceId: "ws-1",
    };
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "draft",
      userId: "owner-1",
    });
    expect(out).toEqual({ status: "skipped", reason: "already_set" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a human-only status is always proposed (forcePropose)", async () => {
    h.proc!.humanOnlyStatuses = ["published"];
    await writeStageSubjectStatus({
      session: SESSION,
      toStage: "publish",
      userId: "owner-1",
    });
    expect(h.update.mock.calls[0]![0]).toMatchObject({
      forcePropose: true,
      source: "user",
    });
  });

  it("skips — no subject, no statusProperty, a stage with no subjectStatus", async () => {
    expect(
      await writeStageSubjectStatus({
        session: { ...SESSION, subjectEntityId: null },
        toStage: "draft",
        userId: "u",
      })
    ).toEqual({ status: "skipped", reason: "no_subject" });
    expect(
      await writeStageSubjectStatus({
        session: SESSION,
        toStage: "idea",
        userId: "u",
      })
    ).toEqual({ status: "skipped", reason: "stage_has_no_subject_status" });
    h.proc!.statusProperty = null;
    expect(
      await writeStageSubjectStatus({
        session: SESSION,
        toStage: "draft",
        userId: "u",
      })
    ).toEqual({ status: "skipped", reason: "no_status_property" });
    expect(h.update).not.toHaveBeenCalled();
  });
});

/**
 * R1 — a ROLE subject (`subjectProfile.profileSlug` is a role-profile). The
 * status lives on the role's FACET: the stage moves it through the status door
 * naming the role, and NEVER falls back to writing the parent entity's JSONB —
 * the defect this pins: a `lead` process wrote `leadStage` onto the person's
 * properties (a status no reader looks at) and reported `written`.
 */
describe("writeStageSubjectStatus — a ROLE subject (R1)", () => {
  const LEAD_STAGES = [
    { key: "research", name: "Research", subjectStatus: "prospect" },
    { key: "decide", name: "Decide", subjectStatus: "qualified" },
  ];
  beforeEach(() => {
    h.proc = {
      stages: LEAD_STAGES,
      profileSlug: "lead",
      statusProperty: "leadStage",
      humanOnlyStatuses: [],
    };
    // The parent is a person; a stale JSONB copy of the role's status must
    // not short-circuit the facet move.
    h.entity = { properties: { leadStage: "qualified" }, workspaceId: "ws-1" };
    subjectProfile.read.mockResolvedValue({
      profileKind: "role",
      lifecycleProperty: "leadStage",
    });
  });

  it("moves the FACET's status through moveStatus, naming the role — never entities.update", async () => {
    h.move.mockResolvedValue({ status: "moved", transition: {} });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "decide",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toEqual({
      status: "written",
      property: "leadStage",
      value: "qualified",
    });
    expect(subjectProfile.read).toHaveBeenCalledWith("lead", "ws-1");
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.move.mock.calls[0]![0]).toMatchObject({
      entityId: "post-1",
      role: "lead",
      property: "leadStage",
      to: "qualified",
      workspaceId: "ws-1",
      actor: { kind: "agent", agentUserId: "agent-1", userId: "owner-1" },
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a role with NO declared lifecycle is a FAILED write — never the parent's JSONB, never `written`", async () => {
    h.move.mockResolvedValue({
      status: "refused",
      code: "NO_LIFECYCLE",
      reason: '"lead" declares no lifecycle',
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "research",
      userId: "owner-1",
    });
    expect(out).toEqual({
      status: "failed",
      reason: '"lead" declares no lifecycle',
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("the role is not attached → failed, nothing written", async () => {
    h.move.mockResolvedValue({
      status: "refused",
      code: "ROLE_NOT_ATTACHED",
      reason: "no lead facet",
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "research",
      userId: "owner-1",
    });
    expect(out.status).toBe("failed");
    expect(h.move.mock.calls[0]![0]).toMatchObject({ role: "lead" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a proposed role move is success, with the playbook's human-only floor", async () => {
    h.proc!.humanOnlyStatuses = ["qualified"];
    h.move.mockResolvedValue({
      status: "proposed",
      proposalId: "p-7",
      proposalType: "entity.transition",
    });
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "decide",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-7" });
    expect(h.move.mock.calls[0]![0]).toMatchObject({
      role: "lead",
      forcePropose: true,
    });
  });
});
