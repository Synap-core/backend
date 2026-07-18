/**
 * Focused contract test for `playbooks.matchForEntity` — the Capture→Session
 * matcher. Verifies (a) it filters to status='active' AND the subject-profile
 * JSONB path, (b) it applies the SAME access-layer scoping as `list`
 * (scopedDb(AccessContext.from(ctx)) — the workspace lens / user floor), and
 * (c) it returns the lean candidate shape, [] when none.
 *
 * DB is mocked (no live Postgres in CI); the assertions are on the composed
 * query + scoping, not on Postgres row filtering.
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
          // workspaceProcedure middleware membership + archive checks
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
    eq: vi.fn((column, value) => ({ eq: [column, value] })),
    desc: vi.fn((column) => ({ desc: column })),
    drizzleSql: vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => ({
        sql: strings.join("?"),
        values,
      })
    ),
  };
});

vi.mock("../access/index.js", () => ({
  AccessContext: { from: mockAccessFrom },
  scopedDb: mockScopedDb,
}));

import { playbooksRouter } from "./playbooks.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";

/** Chainable select() builder whose terminal .orderBy resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  return chain;
}

function callerCtx() {
  return {
    authenticated: true,
    userId: "user-1",
    workspaceId: WORKSPACE,
  } as never;
}

describe("playbooks.matchForEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPredicate.mockReturnValue({ __visibility: true });
    mockDb.query.workspaceMembers.findFirst.mockResolvedValue({
      role: "editor",
    });
    mockDb.query.workspaces.findFirst.mockResolvedValue({ archivedAt: null });
  });

  it("matches active playbooks by subjectProfile and returns the candidate shape", async () => {
    const chain = selectChain([
      {
        id: "pb-1",
        name: "Produce content from this idea",
        goalTemplate: "Produce content for {{platform}} from {{subject}}",
        params: [{ key: "platform", type: "string" }],
        executor: "is-agent",
        subjectProfile: { profileSlug: "post" },
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "post",
      workspaceId: WORKSPACE,
    });

    expect(result).toEqual([
      {
        id: "pb-1",
        name: "Produce content from this idea",
        goalTemplate: "Produce content for {{platform}} from {{subject}}",
        subjectProfileSlug: "post",
        params: [{ key: "platform", type: "string" }],
        executor: "is-agent",
      },
    ]);

    // Scoping identical to `list`: scopedDb(AccessContext.from(ctx)).predicate.
    expect(mockAccessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceId: WORKSPACE })
    );
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
    expect(mockPredicate).toHaveBeenCalledTimes(1);

    // WHERE composes the visibility predicate + status='active' + the
    // subject_profile->>'profileSlug' filter carrying the requested slug.
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __visibility: true });
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
    expect(where.and).toContainEqual(
      expect.objectContaining({ values: expect.arrayContaining(["post"]) })
    );
  });

  it("returns [] when no playbook matches the profile", async () => {
    const chain = selectChain([]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "unmatched-profile",
      workspaceId: WORKSPACE,
    });

    expect(result).toEqual([]);
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
  });

  it("falls back to the requested slug when a row's subjectProfile is missing", async () => {
    const chain = selectChain([
      {
        id: "pb-2",
        name: "Legacy playbook",
        goalTemplate: "Do the thing",
        params: [],
        executor: "is-agent",
        subjectProfile: null,
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const [candidate] = await caller.matchForEntity({
      profileSlug: "deal",
      workspaceId: WORKSPACE,
    });

    expect(candidate.subjectProfileSlug).toBe("deal");
  });
});
