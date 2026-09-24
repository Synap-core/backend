/**
 * `playbooks.list` is a POD-WIDE door.
 *
 * Its predicate — `scopedDb(AccessContext.from(ctx)).predicate(playbooks)` —
 * carries no workspace lens, so it always returned the caller's whole user
 * floor (every member workspace + pod-wide rows). `workspaceProcedure` never
 * narrowed that; it only REFUSED callers without an `X-Workspace-Id` header.
 * Relay is such a caller, and the refusal is half of why "list" and "run"
 * disagreed.
 *
 * NOTE: there is deliberately NO `playbooks.listAll` here. The list/listAll
 * two-door split was collapsed to one floor-first `.list`, and
 * `access/read-scoping.tripwire.test.ts` fails CI on a new `listAll:` door —
 * so the fix is applied to `list` itself, not beside it.
 *
 * DB is mocked; assertions are on the composed query + procedure gating.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockGetDb, mockScopedDb, mockPredicate, mockAccessFrom } =
  vi.hoisted(() => {
    const predicate = vi.fn(() => ({ __visibility: true }));
    return {
      mockPredicate: predicate,
      mockScopedDb: vi.fn(() => ({ predicate })),
      mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
      mockDb: {
        query: {
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

const noWorkspaceCtx = () =>
  ({ authenticated: true, userId: "user-1", workspaceId: null }) as never;
const withWorkspaceCtx = () =>
  ({
    authenticated: true,
    userId: "user-1",
    workspaceId: "00000000-0000-4000-8000-000000000010",
  }) as never;

describe("playbooks.list — pod-wide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredicate.mockReturnValue({ __visibility: true });
    mockDb.query.workspaceMembers.findFirst.mockResolvedValue({
      role: "editor",
    });
    mockDb.query.workspaces.findFirst.mockResolvedValue({ archivedAt: null });
  });

  it("returns rows with NO active workspace in ctx", async () => {
    const chain = selectChain([{ id: "pb-1", name: "Pod-wide playbook" }]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const rows = await playbooksRouter.createCaller(noWorkspaceCtx()).list({});

    // `projectsUsingCount` is additive (tracks, 0272): a playbook that is not
    // a project-scoped method is used by 0 projects, read with no query.
    expect(rows).toEqual([
      { id: "pb-1", name: "Pod-wide playbook", projectsUsingCount: 0 },
    ]);
    expect(mockAccessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
    // No workspaceProcedure membership lookup — the gate is gone because it
    // never narrowed anything.
    expect(mockDb.query.workspaceMembers.findFirst).not.toHaveBeenCalled();
  });

  it("composes the IDENTICAL where-clause with and without a workspace header", async () => {
    const a = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => a) });
    await playbooksRouter.createCaller(noWorkspaceCtx()).list({});

    const b = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => b) });
    await playbooksRouter.createCaller(withWorkspaceCtx()).list({});

    // The header was never a narrow — proving the relaxation changes no rows.
    expect(a._captured.where).toEqual(b._captured.where);
    expect(a._captured.where).toEqual({ and: [{ __visibility: true }] });
  });

  it("still applies the status filter", async () => {
    const chain = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    await playbooksRouter
      .createCaller(noWorkspaceCtx())
      .list({ status: "active" });

    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
  });
});
