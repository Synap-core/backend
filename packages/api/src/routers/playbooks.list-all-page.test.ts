/**
 * Contract test for `playbooks.listAllPage` — the pod-wide sibling of
 * `listPage` (asymmetry fix: playbooks lacked a `protectedProcedure` list like
 * `automations.listPage` already has).
 *
 * Verifies:
 *  (a) `listAllPage` succeeds with NO active workspace in ctx — proving it is
 *      NOT gated behind `workspaceProcedure`'s "Workspace ID required" check,
 *      unlike `listPage`.
 *  (b) the visibility predicate + query shape are otherwise identical to
 *      `listPage` (same `scopedDb(AccessContext.from(ctx)).predicate(playbooks)`,
 *      same cursor contract, same `{ playbooks, nextCursor }` output shape).
 *
 * DB is mocked (no live Postgres in CI); assertions are on the composed
 * query + scoping + procedure gating, not on Postgres row filtering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const { mockDb, mockGetDb, mockScopedDb, mockPredicate, mockAccessFrom } =
  vi.hoisted(() => {
    const predicate = vi.fn(() => ({ __visibility: true }));
    return {
      mockPredicate: predicate,
      mockScopedDb: vi.fn(() => ({ predicate })),
      mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
      mockDb: {
        query: {
          // workspaceProcedure middleware membership + archive checks
          // (only exercised by `listPage`, not `listAllPage`).
          workspaceMembers: {
            findFirst: vi.fn().mockResolvedValue({ role: "editor" }),
          },
          workspaces: {
            findFirst: vi.fn().mockResolvedValue({ archivedAt: null }),
          },
        },
      },
      mockGetDb: vi.fn(),
    };
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    getDb: mockGetDb,
    and: vi.fn((...conditions) => ({ and: conditions.filter(Boolean) })),
    or: vi.fn((...conditions) => ({ or: conditions.filter(Boolean) })),
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    isNull: vi.fn((column) => ({ isNull: column })),
    desc: vi.fn((column) => ({ desc: column })),
    asc: vi.fn((column) => ({ asc: column })),
    gt: vi.fn((column, value) => ({ gt: [column, value] })),
    lt: vi.fn((column, value) => ({ lt: [column, value] })),
  };
});

vi.mock("../access/index.js", () => ({
  AccessContext: { from: mockAccessFrom },
  scopedDb: mockScopedDb,
}));

import { playbooksRouter } from "./playbooks.js";

/** Chainable select() builder whose terminal .limit resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function noWorkspaceCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: null,
  } as never;
}

function withWorkspaceCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: "00000000-0000-4000-8000-000000000010",
  } as never;
}

describe("playbooks.listAllPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredicate.mockReturnValue({ __visibility: true });
    mockDb.query.workspaceMembers.findFirst.mockResolvedValue({
      role: "editor",
    });
    mockDb.query.workspaces.findFirst.mockResolvedValue({ archivedAt: null });
  });

  it("succeeds with NO active workspace in ctx (unlike listPage)", async () => {
    const chain = selectChain([
      {
        id: "pb-1",
        name: "Pod-wide playbook",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(noWorkspaceCtx());
    const result = await caller.listAllPage({});

    expect(result.playbooks).toEqual([
      {
        id: "pb-1",
        name: "Pod-wide playbook",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(result.nextCursor).toBeNull();

    // Scoping identical to `listPage`: scopedDb(AccessContext.from(ctx)).predicate.
    expect(mockAccessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
    expect(mockPredicate).toHaveBeenCalledTimes(1);

    // No workspace membership lookup performed — `listAllPage` is NOT gated
    // behind `workspaceProcedure`.
    expect(mockDb.query.workspaceMembers.findFirst).not.toHaveBeenCalled();
  });

  it("mutation-test: listPage DOES reject with no active workspace (the asymmetry listAllPage fixes)", async () => {
    const caller = playbooksRouter.createCaller(noWorkspaceCtx());

    await expect(caller.listPage({})).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.listPage({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("narrows to a specific workspace (still includes pod-wide rows) when workspaceId is passed", async () => {
    const chain = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(withWorkspaceCtx());
    await caller.listAllPage({
      workspaceId: "00000000-0000-4000-8000-000000000010",
    });

    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __visibility: true });
    expect(where.and).toContainEqual(
      expect.objectContaining({
        or: expect.arrayContaining([
          expect.objectContaining({ isNull: expect.anything() }),
          expect.objectContaining({
            eq: expect.arrayContaining([
              "00000000-0000-4000-8000-000000000010",
            ]),
          }),
        ]),
      })
    );
  });
});
