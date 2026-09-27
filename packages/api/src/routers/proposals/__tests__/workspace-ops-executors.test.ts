/**
 * R8a — the approval halves of the governed workspace operations.
 *
 * A governed write that files a proposal nothing applies is this repo's most
 * repeated defect. Each executor here must REPLAY the router procedure the
 * direct path runs (never reconstruct the write), as the APPROVER, and refuse
 * a re-proposal instead of flipping APPROVED with nothing done:
 *
 *   workspace/archive, workspace/restore → workspacesRouter.archive
 *   workspace/update  (rename shape)     → workspacesRouter.update
 *                                          (NOT materializeWorkspaceCore — before
 *                                          R8a an approved rename renamed nothing)
 *   entity/update     ({ id, toWorkspaceId }) → entitiesRouter.moveToWorkspace
 *                                          (before R8a an approved move moved nothing)
 *   profile/grant_access                 → profilesRouter.grantAccess
 *
 * Routers are mocked at the module seam; the procedures themselves are pinned
 * in `workspaces.archive-governed.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const h = vi.hoisted(() => ({
  ctxs: [] as Array<Record<string, unknown>>,
  archive: vi.fn(),
  wsUpdate: vi.fn(),
  move: vi.fn(),
  entUpdate: vi.fn(),
  grant: vi.fn(),
  materialize: vi.fn(),
  membership: { role: "owner" } as { role: string } | null,
  proposalStatus: "pending",
  updates: [] as unknown[],
}));

vi.mock("../../workspaces.js", () => ({
  workspacesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { archive: h.archive, update: h.wsUpdate };
    },
  },
}));
vi.mock("../../entities.js", () => ({
  mergeSystemData: vi.fn(),
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { moveToWorkspace: h.move, update: h.entUpdate };
    },
  },
}));
vi.mock("../../profiles.js", () => ({
  profilesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { grantAccess: h.grant };
    },
  },
}));
vi.mock("../../../services/workspace-materialization-service.js", () => {
  class E extends Error {}
  return {
    materializeWorkspaceCore: (...a: unknown[]) => h.materialize(...a),
    ComposeBaseUnavailableError: E,
    DependencyResolutionError: E,
    ComposeBaseNotFoundError: E,
    ComposeOverlayError: E,
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getWorkspaceMembership: async () => h.membership,
    db: {
      select: () => ({
        from: () => ({
          where: async () => [{ status: h.proposalStatus }],
        }),
      }),
      update: () => ({
        set: (v: unknown) => ({
          where: async () => {
            h.updates.push(v);
          },
        }),
      }),
      query: { entities: { findFirst: async () => null } },
    },
  };
});

import { proposalExecRegistry } from "../execution-registry.js";
import { registerWorkspaceExecutors } from "../executors/workspace.js";
import { registerEntityExecutors } from "../executors/entity.js";
import { registerProfileExecutors } from "../executors/profile.js";

const APPROVER = "55555555-5555-4555-8555-555555555555";
const WS = "33333333-3333-4333-8333-333333333333";
const WS_TO = "66666666-6666-4666-8666-666666666666";
const ENTITY = "77777777-7777-4777-8777-777777777777";
const PROFILE = "88888888-8888-4888-8888-888888888888";

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
} as never;

function run(
  key: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  const exec = proposalExecRegistry.resolve(key);
  if (!exec) throw new Error(`no executor for ${key}`);
  return exec.execute({
    proposal: {
      id: "p-1",
      targetType: key.split("/")[0],
      targetId: (data.id as string) ?? null,
      proposalType: key.split("/")[1],
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      subjectUserId: "owner-1",
      sourceMessageId: null,
      data: { requestId: "r-1", data },
      ...extra,
    },
    payload: data as never,
    userId: APPROVER,
    input: { proposalId: "p-1" },
    ctx: {} as never,
    deps,
  } as never);
}

beforeAll(() => {
  registerWorkspaceExecutors();
  registerEntityExecutors();
  registerProfileExecutors();
});

beforeEach(() => {
  for (const fn of [
    h.archive,
    h.wsUpdate,
    h.move,
    h.entUpdate,
    h.grant,
    h.materialize,
  ])
    fn.mockReset();
  h.ctxs = [];
  h.updates = [];
  h.membership = { role: "owner" };
  h.proposalStatus = "pending";
});

describe("workspace/archive + workspace/restore", () => {
  it.each([
    ["workspace/archive", false],
    ["workspace/restore", true],
  ] as const)(
    "%s replays workspacesRouter.archive as the approver",
    async (key, restore) => {
      h.archive.mockResolvedValue({
        status: restore ? "restored" : "archived",
      });
      const res = await run(key, { id: WS, name: "W", restore });
      expect(h.archive).toHaveBeenCalledWith({ workspaceId: WS, restore });
      expect(h.ctxs[0]).toMatchObject({ userId: APPROVER, workspaceId: WS });
      expect(res).toMatchObject({ success: true });
      expect(h.updates).toHaveLength(1);
    }
  );

  it("a re-proposal is refused, never flipped APPROVED", async () => {
    h.archive.mockResolvedValue({ status: "proposed", proposalId: "p-2" });
    await expect(run("workspace/archive", { id: WS })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.updates).toHaveLength(0);
  });

  it("an already-approved proposal does not re-run", async () => {
    h.proposalStatus = "approved";
    const res = await run("workspace/archive", { id: WS });
    expect(res).toMatchObject({ alreadyApproved: true });
    expect(h.archive).not.toHaveBeenCalled();
  });
});

describe("workspace/update — the rename shape", () => {
  it("replays workspacesRouter.update, never the package materializer", async () => {
    h.wsUpdate.mockResolvedValue({ status: "updated" });
    const res = await run("workspace/update", { id: WS, name: "Renamed" });
    expect(h.wsUpdate).toHaveBeenCalledWith({ id: WS, name: "Renamed" });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, primaryId: WS });
    expect(h.updates).toHaveLength(1);
  });

  it("a package-install shape (definition) does NOT take the rename branch", async () => {
    h.materialize.mockRejectedValue(new Error("materialize reached"));
    await expect(
      run("workspace/update", {
        definition: { name: "pkg" },
        targetWorkspaceId: WS,
      })
    ).rejects.toThrow("materialize reached");
    expect(h.wsUpdate).not.toHaveBeenCalled();
  });
});

describe("entity/update — a governed MOVE", () => {
  it("replays moveToWorkspace, not a field update", async () => {
    h.move.mockResolvedValue({ moved: [ENTITY], proposed: [], errors: [] });
    const res = await run("entity/update", {
      id: ENTITY,
      toWorkspaceId: WS_TO,
    });
    expect(h.move).toHaveBeenCalledWith({
      entityIds: [ENTITY],
      workspaceId: WS_TO,
    });
    expect(h.entUpdate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, primaryId: ENTITY });
    expect(h.updates).toHaveLength(1);
  });

  it("a move the approver cannot apply is refused, not approved", async () => {
    h.move.mockResolvedValue({
      moved: [],
      proposed: [],
      errors: [{ entityId: ENTITY, error: "Entity not found" }],
    });
    await expect(
      run("entity/update", { id: ENTITY, toWorkspaceId: WS_TO })
    ).rejects.toThrow(/Entity not found/);
    h.move.mockResolvedValue({
      moved: [],
      proposed: [{ entityId: ENTITY, proposalId: "p-9" }],
      errors: [],
    });
    await expect(
      run("entity/update", { id: ENTITY, toWorkspaceId: WS_TO })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.updates).toHaveLength(0);
  });
});

describe("profile/grant_access", () => {
  it("replays profilesRouter.grantAccess in the proposal's workspace", async () => {
    h.grant.mockResolvedValue({ success: true, status: "granted" });
    const res = await run("profile/grant_access", {
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    expect(h.grant).toHaveBeenCalledWith({
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    expect(h.ctxs[0]).toMatchObject({ userId: APPROVER, workspaceId: WS });
    expect(res).toMatchObject({ success: true, primaryId: PROFILE });
  });

  it("refuses a re-proposal and a non-member approver", async () => {
    h.grant.mockResolvedValue({ success: false, status: "proposed" });
    await expect(
      run("profile/grant_access", {
        profileId: PROFILE,
        targetWorkspaceId: WS_TO,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.membership = null;
    await expect(
      run("profile/grant_access", {
        profileId: PROFILE,
        targetWorkspaceId: WS_TO,
      })
    ).rejects.toThrow(/No workspace access/);
    expect(h.updates).toHaveLength(0);
  });
});
