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
    statusProperty: string | null;
    humanOnlyStatuses: string[];
  },
  entity: null as null | { properties: Record<string, unknown>; workspaceId: string },
  update: vi.fn(async (_input: Record<string, unknown>) => ({ status: "updated" }) as Record<string, unknown>),
  ctx: [] as Array<Record<string, unknown>>,
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
  h.proc = { stages: STAGES, statusProperty: "post-status", humanOnlyStatuses: [] };
  h.entity = { properties: { "post-status": "idea" }, workspaceId: "ws-1" };
  h.update.mockClear();
  h.update.mockResolvedValue({ status: "updated" });
  h.ctx.length = 0;
});

describe("writeStageSubjectStatus", () => {
  it("writes the stage's subjectStatus through entities.update, as the driving agent, in the session", async () => {
    const out = await writeStageSubjectStatus({
      session: SESSION,
      toStage: "draft",
      userId: "owner-1",
      agentUserId: "agent-1",
    });
    expect(out).toEqual({ status: "written", property: "post-status", value: "drafting" });
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
    h.update.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-9" });
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
    h.entity = { properties: { "post-status": "drafting" }, workspaceId: "ws-1" };
    const out = await writeStageSubjectStatus({ session: SESSION, toStage: "draft", userId: "owner-1" });
    expect(out).toEqual({ status: "skipped", reason: "already_set" });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a human-only status is always proposed (forcePropose)", async () => {
    h.proc!.humanOnlyStatuses = ["published"];
    await writeStageSubjectStatus({ session: SESSION, toStage: "publish", userId: "owner-1" });
    expect(h.update.mock.calls[0]![0]).toMatchObject({ forcePropose: true, source: "user" });
  });

  it("skips — no subject, no statusProperty, a stage with no subjectStatus", async () => {
    expect(
      await writeStageSubjectStatus({ session: { ...SESSION, subjectEntityId: null }, toStage: "draft", userId: "u" })
    ).toEqual({ status: "skipped", reason: "no_subject" });
    expect(
      await writeStageSubjectStatus({ session: SESSION, toStage: "idea", userId: "u" })
    ).toEqual({ status: "skipped", reason: "stage_has_no_subject_status" });
    h.proc!.statusProperty = null;
    expect(
      await writeStageSubjectStatus({ session: SESSION, toStage: "draft", userId: "u" })
    ).toEqual({ status: "skipped", reason: "no_status_property" });
    expect(h.update).not.toHaveBeenCalled();
  });
});
