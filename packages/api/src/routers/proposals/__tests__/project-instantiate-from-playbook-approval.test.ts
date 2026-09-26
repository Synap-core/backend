/**
 * `project/instantiate_from_playbook` — the APPROVAL HALF.
 *
 * A governed write door with no approve-executor is a defect this codebase has
 * shipped three times: the proposal sits pending, approval hits the `*​/*`
 * catch-all, and NOTHING happens while the reviewer sees success. This file
 * proves the executor exists and actually applies.
 *
 * It also pins the ACTING PRINCIPAL. `ProjectRepository.update` gates
 * `.where(eq(projects.userId, userId))` — an OWNERSHIP predicate — so replaying
 * as the APPROVER matches no row, throws before the status update, and leaves
 * the proposal PENDING forever. The replay must run as the project's owner.
 *
 * W5c: the replay calls `startTrack` (services/tracks) DIRECTLY — the retired
 * `projects.instantiateFromPlaybook` wrapper is no longer in the path. The
 * router mock below deliberately exposes NO `instantiateFromPlaybook`, so a
 * replay that still went through the router would throw.
 *
 * DB + router access are mocked; assertions are on the calls issued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProposalExecutorArgs,
  ProposalExecutorDeps,
} from "../execution-registry.js";

let projectRow:
  { id: string; workspaceId: string | null; userId: string } | undefined;
let membership: { role: string } | undefined;
let selectRows: Array<{ status: string }> = [];
const proposalUpdates: Array<Record<string, unknown>> = [];
const bindCalls: Array<{
  projectId: string;
  playbookId: string;
  actor: { userId: string; agentUserId?: string | null };
}> = [];
let bindResult: { status?: string } = { status: "started" };

const dbStub = {
  query: { projects: { findFirst: async () => projectRow } },
  select: () => ({ from: () => ({ where: async () => selectRows }) }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        proposalUpdates.push(values);
      },
    }),
  }),
};

vi.mock("@synap/database", () => ({
  db: dbStub,
  proposals: { __table: "proposals" },
  projects: { __table: "projects" },
  relations: { __table: "relations" },
  projectMembers: { __table: "project_members" },
  eq: () => ({}),
  and: () => ({}),
  sql: {},
  drizzleSql: Object.assign(() => ({}), { raw: () => ({}) }),
  getWorkspaceMembership: async () => membership,
  ProjectRepository: class {},
  EventRepository: class {},
}));

vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved", PENDING: "pending" },
}));

vi.mock("@synap/events", () => ({ emitSideEffects: () => {} }));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => null }));

vi.mock("../../projects.js", () => ({
  projectsRouter: {
    createCaller: () => ({
      create: async () => ({}),
      update: async () => ({}),
      setAutomationMembership: async () => ({}),
    }),
  },
}));

vi.mock("../../../services/tracks/tracks-service.js", () => ({
  startTrack: async (args: (typeof bindCalls)[number]) => {
    bindCalls.push(args);
    return bindResult;
  },
}));

const { proposalExecRegistry } = await import("../execution-registry.js");
const { registerProjectExecutors } = await import("../executors/project.js");

registerProjectExecutors();

const APPROVER = "human-approver";
const OWNER = "project-owner";
const PROJECT_ID = "p-1";
const PLAYBOOK_ID = "pb-1";

const deps = {
  db: dbStub,
  emitProposalReviewed: () => {},
  reportProposalOutcome: () => {},
} as unknown as ProposalExecutorDeps;

function runArgs(data: unknown, workspaceId: string | null = "ws-1") {
  return {
    proposal: {
      id: "prop-1",
      targetType: "project",
      targetId: PROJECT_ID,
      proposalType: "instantiate_from_playbook",
      workspaceId,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      sourceMessageId: null,
      data,
    },
    payload: null,
    userId: APPROVER,
    input: { proposalId: "prop-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  } as ProposalExecutorArgs;
}

function executor() {
  const ref = proposalExecRegistry.resolveExact(
    "project/instantiate_from_playbook"
  );
  if (!ref) throw new Error("no executor registered");
  return ref;
}

beforeEach(() => {
  projectRow = { id: PROJECT_ID, workspaceId: "ws-1", userId: OWNER };
  membership = { role: "admin" };
  selectRows = [];
  proposalUpdates.length = 0;
  bindCalls.length = 0;
  bindResult = { status: "started" };
});

describe("project/instantiate_from_playbook approval", () => {
  it("is registered — approval does NOT fall to the catch-all", () => {
    expect(typeof executor().execute).toBe("function");
  });

  it("APPLIES on approval, as the project's OWNER, with both ids", async () => {
    const result = await executor().execute(
      runArgs({ data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID } })
    );

    expect(result).toMatchObject({ success: true });
    expect(bindCalls).toHaveLength(1);
    // Straight into the ONE track door, as the OWNER (not the approver), with
    // no agent attribution — the approver is the authority, so it applies.
    expect(bindCalls[0]).toEqual({
      projectId: PROJECT_ID,
      playbookId: PLAYBOOK_ID,
      actor: { userId: OWNER, agentUserId: null, isHubProtocol: false },
    });
    // …and the proposal is closed, attributed to whoever actually approved.
    expect(proposalUpdates[0]).toMatchObject({
      status: "approved",
      reviewedBy: APPROVER,
    });
  });

  it("works for a POD-PERSONAL project (NULL workspace) — no membership lookup", async () => {
    projectRow = { id: PROJECT_ID, workspaceId: null, userId: OWNER };
    membership = undefined;

    await executor().execute(
      runArgs({ data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID } }, null)
    );

    expect(bindCalls[0].actor).toMatchObject({ userId: OWNER });
    expect(proposalUpdates[0]).toMatchObject({ status: "approved" });
  });

  it("REJECTS a proposal whose data lost the playbook id", async () => {
    await expect(
      executor().execute(runArgs({ data: { id: PROJECT_ID } }))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(bindCalls).toEqual([]);
    expect(proposalUpdates).toEqual([]);
  });

  it("a re-propose on replay THROWS instead of silently looping", async () => {
    // assertApplied: the replay must APPLY. A `{status:'proposed'}` answer means
    // the approver's role cannot execute the write, so approving only filed a
    // SECOND proposal — a silent no-op wearing an approval.
    bindResult = { status: "proposed" };

    await expect(
      executor().execute(
        runArgs({ data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID } })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The original proposal stays PENDING so a real reviewer can still approve.
    expect(proposalUpdates).toEqual([]);
  });

  it("is idempotent — an already-approved proposal does not re-apply", async () => {
    selectRows = [{ status: "approved" }];

    const result = await executor().execute(
      runArgs({ data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID } })
    );

    expect(result).toMatchObject({ alreadyApproved: true });
    expect(bindCalls).toEqual([]);
  });

  it("workspace-scoped NEGATIVE: a non-member is rejected and nothing is written", async () => {
    membership = undefined;

    await expect(
      executor().execute(
        runArgs({ data: { id: PROJECT_ID, playbookId: PLAYBOOK_ID } })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(bindCalls).toEqual([]);
    expect(proposalUpdates).toEqual([]);
  });
});
