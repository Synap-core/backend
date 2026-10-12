/**
 * An APPROVED replay of a run proposal gates on the APPROVER, not the agent.
 *
 * The defect (2026-10-12, proposal f63ee7b6 on the founder pod): the
 * `playbook/run` executor replays an approved proposal through `playbooks.run`
 * and passes `agentUserId: proposal.agentUserId` so the agent still owns the
 * session. That same input reached `checkPermissionOrPropose`, so the replay
 * was judged on the AGENT's policy — and an agent whose policy is "propose"
 * (Raycast: "Agent requires proposal for all write operations") filed a NEW
 * proposal on every approval. The approval then failed with "your workspace
 * role cannot run this playbook", for an admin.
 *
 * The executor now sets `ctx.governanceProposalId`; this pins what the door
 * does with it: the gate sees NO agent, `runPlaybook` still gets the agent,
 * and the skill preflight files nothing in the agent's name.
 *
 * Covers the router seam only (the gate is mocked) — what the real gate does
 * with an agent id is its own suite's job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS_A = "00000000-0000-4000-8000-00000000000a";
const PB_ID = "00000000-0000-4000-8000-000000000091";

const {
  mockDb,
  mockGetDb,
  mockScopedFindFirst,
  mockAssertWorkspaceWrite,
  mockCheckPermission,
  mockRunPlaybook,
  mockFindUnenabled,
  mockWorkspacesFindFirst,
} = vi.hoisted(() => {
  const entitiesFindFirst = vi.fn();
  const workspacesFindFirst = vi.fn();
  return {
    mockScopedFindFirst: vi.fn(),
    mockAssertWorkspaceWrite: vi.fn(async () => undefined),
    mockCheckPermission: vi.fn(async () => ({ allowed: true })),
    mockRunPlaybook: vi.fn(async () => ({
      run: { id: "run-1" },
      session: { id: "sess-1" },
    })),
    mockFindUnenabled: vi.fn(async () => []),
    mockEntitiesFindFirst: entitiesFindFirst,
    mockWorkspacesFindFirst: workspacesFindFirst,
    mockGetDb: vi.fn(),
    mockDb: {
      query: {
        workspaceMembers: {
          findFirst: vi.fn().mockResolvedValue({ role: "editor" }),
        },
        workspaces: { findFirst: workspacesFindFirst },
        entities: { findFirst: entitiesFindFirst },
      },
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: mockDb, getDb: mockGetDb };
});

vi.mock("../access/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../access/index.js")>();
  return {
    ...actual,
    scopedDb: vi.fn(() => ({
      findFirst: mockScopedFindFirst,
      predicate: vi.fn(() => undefined),
    })),
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/split-brain-service.js")>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: mockAssertWorkspaceWrite,
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/permission-check.js")>();
  return { ...actual, checkPermissionOrPropose: mockCheckPermission };
});

vi.mock("../services/playbooks/run-playbook.js", () => ({
  runPlaybook: mockRunPlaybook,
}));

const mockResolveTrackFiling = vi.hoisted(() =>
  vi.fn(async () => ({ projectId: "00000000-0000-4000-8000-0000000000f1" }))
);
vi.mock("../services/tracks/tracks-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTrackFiling: mockResolveTrackFiling,
}));

const mockProposeEnable = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../services/capabilities/propose-capability-enable.js", () => ({
  proposeCapabilityEnable: mockProposeEnable,
}));

vi.mock("../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: mockFindUnenabled,
}));

import { playbooksRouter } from "./playbooks.js";

const PLAYBOOK_IN_A = {
  id: PB_ID,
  name: "Weekly review",
  workspaceId: WS_A,
  goalTemplate: "do the thing",
  params: null,
  status: "active",
};

const AGENT = "00000000-0000-4000-8000-0000000000a6";
const ctx = (governanceProposalId?: string) =>
  ({
    authenticated: true,
    userId: "user-1",
    workspaceId: WS_A,
    ...(governanceProposalId ? { governanceProposalId } : {}),
  }) as never;

describe("playbooks.run — an approved replay is the approver's decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue(mockDb);
    mockScopedFindFirst.mockResolvedValue(PLAYBOOK_IN_A);
    mockAssertWorkspaceWrite.mockResolvedValue(undefined);
    mockCheckPermission.mockResolvedValue({ allowed: true } as never);
    mockFindUnenabled.mockResolvedValue([] as never);
    mockRunPlaybook.mockResolvedValue({
      run: { id: "run-1" },
      session: { id: "sess-1" },
    } as never);
    mockWorkspacesFindFirst.mockResolvedValue({ archivedAt: null });
    mockDb.query.workspaceMembers.findFirst.mockResolvedValue({
      role: "editor",
    });
  });

  it("gates on the approver, while the agent still owns the run", async () => {
    const res = await playbooksRouter
      .createCaller(ctx("proposal-1"))
      .run({ playbookId: PB_ID, agentUserId: AGENT });

    expect(res.status).toBe("running");
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    expect((mockCheckPermission.mock.calls[0] as unknown[])[0]).toMatchObject({
      userId: "user-1",
      agentUserId: undefined,
    });
    expect(mockRunPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ agentUserId: AGENT })
    );
  });

  it("control: a direct agent run is still gated on the agent", async () => {
    await playbooksRouter
      .createCaller(ctx())
      .run({ playbookId: PB_ID, agentUserId: AGENT });

    expect((mockCheckPermission.mock.calls[0] as unknown[])[0]).toMatchObject({
      agentUserId: AGENT,
    });
  });

  it("skills not enabled: says so as `blocked`, files no request in the agent's name, never throws", async () => {
    mockFindUnenabled.mockResolvedValue([{ name: "Web reader" }] as never);
    const res = await playbooksRouter
      .createCaller(ctx("proposal-1"))
      .run({ playbookId: PB_ID, agentUserId: AGENT });

    expect(res.status).toBe("blocked");
    expect(res.message).toContain("Web reader");
    expect(res.message).toContain("approve again");
    expect(mockProposeEnable).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockRunPlaybook).not.toHaveBeenCalled();
  });
});
