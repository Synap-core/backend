/**
 * What `relations.delete` and `relations.exposeToAnchor` FILE with the gate.
 *
 * D2: an unlink proposal carries the relation's endpoints. Approval
 * hard-deletes the row, so a payload holding only `{ id }` can never name what
 * it removed, and the card read "Delete relation". The endpoints come from a
 * snapshot taken under the write floor, BEFORE the gate is called.
 *
 * D3: an exposure edge is never filed as `relation/create` (in
 * DEFAULT_AUTO_APPROVE). Since Sites W2 S3 `exposeToAnchor` is an alias of the
 * share door and files `share/create` (ADMIN-floored, classes `access`);
 * `relation.expose` stays floored for proposals filed before the alias.
 *
 * Harness: the same partial-mock shape as
 * relations.grant-anchor-membership.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockCheckPermission,
  mockAssertWrite,
  mockMembership,
  mockRelationFindFirst,
  mockRelationDelete,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const mockRelationFindFirst = vi.fn();
  const mockDatabase = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectQueue.shift() ?? []),
        }),
      }),
    }),
    query: {
      relations: { findFirst: mockRelationFindFirst },
      entities: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    __queue: selectQueue,
  };
  return {
    mockGetDb: vi.fn(async () => mockDatabase),
    mockCheckPermission: vi.fn(),
    mockAssertWrite: vi.fn(),
    mockMembership: vi.fn(),
    mockRelationFindFirst,
    mockRelationDelete: vi.fn(),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: mockGetDb,
    eventRepository: { __shared: true },
    getWorkspaceMembership: mockMembership,
    RelationRepository: class {
      delete = mockRelationDelete;
      create = vi.fn();
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: mockCheckPermission,
}));
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: mockAssertWrite,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { TRPCError } from "@trpc/server";
import { relationsRouter } from "./relations.js";

const USER = "00000000-0000-4000-8000-0000000000aa";
const REL = "00000000-0000-4000-8000-000000000003";
const SRC = "00000000-0000-4000-8000-000000000001";
const TGT = "00000000-0000-4000-8000-000000000002";
const WS = "00000000-0000-4000-8000-000000000010";

const caller = relationsRouter.createCaller({
  authenticated: true,
  userId: USER,
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertWrite.mockResolvedValue(undefined);
  mockCheckPermission.mockResolvedValue({ proposalId: "prop-1" });
});

describe("relations.delete — the unlink proposal names its endpoints", () => {
  it("files { id, sourceEntityId, targetEntityId, type } read from the stored row", async () => {
    mockRelationFindFirst.mockResolvedValueOnce({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "works_with",
      workspaceId: WS,
    });

    const res = await caller.delete({ id: REL });

    expect(res).toEqual({ status: "proposed", proposalId: "prop-1" });
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    const opts = mockCheckPermission.mock.calls[0][0];
    expect(opts.subjectType).toBe("relation");
    expect(opts.action).toBe("delete");
    // `id` is still the executor's key (executors/entity.ts relation/delete).
    expect(opts.data).toEqual({
      id: REL,
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "works_with",
    });
    // Proposed ⇒ nothing deleted yet.
    expect(mockRelationDelete).not.toHaveBeenCalled();
  });

  it("floors BEFORE filing: a caller who cannot write the relation's workspace files nothing", async () => {
    mockRelationFindFirst.mockResolvedValueOnce({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "works_with",
      workspaceId: WS,
    });
    mockAssertWrite.mockRejectedValueOnce(
      new TRPCError({ code: "FORBIDDEN", message: "not a member" })
    );

    await expect(caller.delete({ id: REL })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The floor ran against the LOADED row's workspace…
    expect(mockAssertWrite).toHaveBeenCalledWith(expect.anything(), USER, {
      workspaceId: WS,
    });
    // …and no proposal carrying the endpoints was filed.
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it("an unknown relation id is NOT_FOUND and files nothing", async () => {
    mockRelationFindFirst.mockResolvedValueOnce(undefined);

    await expect(caller.delete({ id: REL })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it("the direct (allowed) path still deletes once", async () => {
    mockRelationFindFirst.mockResolvedValueOnce({
      sourceEntityId: SRC,
      targetEntityId: TGT,
      type: "works_with",
      workspaceId: WS,
    });
    mockCheckPermission.mockResolvedValueOnce({ allowed: true });
    mockRelationDelete.mockResolvedValueOnce(undefined);

    await caller.delete({ id: REL });

    expect(mockRelationDelete).toHaveBeenCalledWith(REL, USER);
    expect(mockRelationFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("relations.exposeToAnchor — a thin alias of the share door (Sites W2 S3)", () => {
  it("files the ADMIN-floored share/create pair (a guest share of the entity with the anchor)", async () => {
    const db = (await mockGetDb()) as unknown as { __queue: unknown[][] };
    db.__queue.length = 0;
    db.__queue.push(
      [{ id: SRC, workspaceId: WS, userId: USER }], // exposed entity
      [{ id: TGT, workspaceId: WS, userId: USER }], // anchor project (caller owns it)
      [{ settings: {} }] // the entity's workspace: no exposure policy → default
    );

    const res = await caller.exposeToAnchor({ entityId: SRC, anchorId: TGT });

    expect(res).toEqual({ status: "proposed", proposalId: "prop-1" });
    const opts = mockCheckPermission.mock.calls[0][0];
    // Was `relation` / `expose`; the alias now files the share door's pair,
    // which is in ADMIN_ACTIONS_LIVE (governance-policy share-floor.test.ts).
    expect(opts.subjectType).toBe("share");
    expect(opts.action).toBe("create");
    expect(opts.workspaceId).toBe(WS);
    expect(opts.data).toMatchObject({
      resourceType: "entity",
      resourceId: SRC,
      anchorProjectId: TGT,
      audience: "guest",
      workspaceId: WS,
    });
  });
});

describe("relation.expose — an agent proposes, where relation.create executed", () => {
  it("is absent from DEFAULT_AUTO_APPROVE, so the ladder proposes for an agent", async () => {
    const { decideAgentPolicy, DEFAULT_AUTO_APPROVE } =
      await import("@synap/governance-policy");
    expect(DEFAULT_AUTO_APPROVE).not.toContain("relation.expose");
    // The baseline this verb replaces: under `create`, the same edge ran.
    expect(
      decideAgentPolicy({ subjectType: "relation", action: "create" }).verdict
    ).toBe("execute");
    expect(
      decideAgentPolicy({ subjectType: "relation", action: "expose" }).verdict
    ).toBe("propose");
  });
});
