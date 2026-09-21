/**
 * REPRODUCTION + PARITY contract for `playbooks.run` as a POD-WIDE door.
 *
 * The defect: Relay lists playbooks with `playbooks.list`, whose predicate is
 * `scopedDb(AccessContext.from(ctx))` with NO lens — i.e. the USER FLOOR, every
 * member workspace plus pod-wide rows. But `run` was a `workspaceProcedure`
 * that filed the run into `ctx.workspaceId` (the ambient `X-Workspace-Id`
 * header), so a playbook listed from workspace A and launched while the header
 * said B reached `resolveRunnablePlaybook` with a mismatched workspace and
 * threw `playbook <id> not visible in workspace <B>`.
 *
 * The Hub/MCP door (`runPlaybookDoor`) never had this problem: it resolves the
 * playbook on the user floor and derives the write workspace from the playbook
 * via `resolvePlaybookRunWriteWorkspace`. This file pins the tRPC door to the
 * same behaviour, and pins the guards that must still run against the RESOLVED
 * workspace (editor+ write floor, subject IDOR, governance).
 *
 * DB is mocked (no live Postgres in CI).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const PB_ID = "00000000-0000-4000-8000-000000000091";

const {
  mockDb,
  mockGetDb,
  mockScopedFindFirst,
  mockAssertWorkspaceWrite,
  mockCheckPermission,
  mockRunPlaybook,
  mockFindUnenabled,
  mockEntitiesFindFirst,
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

vi.mock("../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: mockFindUnenabled,
}));

import { playbooksRouter } from "./playbooks.js";

function ctxWith(workspaceId: string | null) {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId,
  } as never;
}

const PLAYBOOK_IN_A = {
  id: PB_ID,
  name: "Weekly review",
  workspaceId: WS_A,
  goalTemplate: "do the thing",
  params: null,
  status: "active",
};

describe("playbooks.run — pod-wide door parity with runPlaybookDoor", () => {
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

  it("(a) runs with NO X-Workspace-Id header — files the run in the playbook's own workspace", async () => {
    const caller = playbooksRouter.createCaller(ctxWith(null));
    const result = await caller.run({ playbookId: PB_ID });

    expect(result.status).toBe("running");
    expect(mockRunPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A })
    );
  });

  it("(b) header names workspace B, playbook lives in A → run is filed in A, not B", async () => {
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));
    await caller.run({ playbookId: PB_ID });

    expect(mockRunPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A })
    );
    // The editor+ write floor runs against the RESOLVED workspace (where the
    // session/channel/run rows actually land), never the ambient header.
    expect(mockAssertWorkspaceWrite).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { workspaceId: WS_A }
    );
    // Governance is keyed to the resolved workspace too.
    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A })
    );
    // And so is the unenabled-skill preflight.
    expect(mockFindUnenabled).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A })
    );
  });

  it("(c) pod-wide (NULL workspace) playbook + header B → filed in B (ambient is the last rung)", async () => {
    mockScopedFindFirst.mockResolvedValue({
      ...PLAYBOOK_IN_A,
      workspaceId: null,
    });
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));
    await caller.run({ playbookId: PB_ID });

    expect(mockRunPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_B })
    );
  });

  it("(d) pod-wide playbook + no header + no subject → honest refusal, never an arbitrary workspace", async () => {
    mockScopedFindFirst.mockResolvedValue({
      ...PLAYBOOK_IN_A,
      workspaceId: null,
    });
    const caller = playbooksRouter.createCaller(ctxWith(null));

    // The MESSAGE discriminates: before the fix this also threw BAD_REQUEST,
    // but from `workspaceProcedure`'s "Workspace ID required" header gate —
    // not from an honest ladder refusal naming the playbook.
    await expect(caller.run({ playbookId: PB_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("is a pod-wide playbook"),
    });
    expect(mockRunPlaybook).not.toHaveBeenCalled();
  });

  it("(e) a playbook NOT on the user floor is still NOT_FOUND", async () => {
    mockScopedFindFirst.mockResolvedValue(undefined);
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));

    await expect(caller.run({ playbookId: PB_ID })).rejects.toBeInstanceOf(
      TRPCError
    );
    await expect(caller.run({ playbookId: PB_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("(f) subject IDOR guard runs against the RESOLVED workspace", async () => {
    // Subject lives in B; the run resolves to A → the subject must be rejected.
    mockEntitiesFindFirst.mockResolvedValue({
      id: "00000000-0000-4000-8000-0000000000e1",
      workspaceId: WS_B,
    });
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));

    await expect(
      caller.run({
        playbookId: PB_ID,
        subjectId: "00000000-0000-4000-8000-0000000000e1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockRunPlaybook).not.toHaveBeenCalled();
  });

  it("(f2) non-member of the RESOLVED workspace is FORBIDDEN (the gate moved, it did not vanish)", async () => {
    // Caller is a member of the header workspace B but NOT of A, where the
    // playbook lives and the run would be filed.
    mockDb.query.workspaceMembers.findFirst.mockResolvedValue(undefined);
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));

    await expect(caller.run({ playbookId: PB_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mockRunPlaybook).not.toHaveBeenCalled();
  });

  it("(f3) an ARCHIVED resolved workspace is FORBIDDEN", async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ archivedAt: new Date() });
    const caller = playbooksRouter.createCaller(ctxWith(WS_B));

    await expect(caller.run({ playbookId: PB_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("archived"),
    });
    expect(mockRunPlaybook).not.toHaveBeenCalled();
  });

  it("(g) explicit input.workspaceId outranks the playbook's home", async () => {
    const caller = playbooksRouter.createCaller(ctxWith(null));
    await caller.run({ playbookId: PB_ID, workspaceId: WS_B });

    expect(mockRunPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_B })
    );
    expect(mockAssertWorkspaceWrite).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { workspaceId: WS_B }
    );
  });
});
