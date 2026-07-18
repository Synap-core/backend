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

const {
  mockDb,
  mockGetDb,
  mockScopedDb,
  mockPredicate,
  mockAccessFrom,
  mockLoadFacetSlugsBatch,
} = vi.hoisted(() => {
  const predicate = vi.fn(() => ({ __visibility: true }));
  return {
    mockPredicate: predicate,
    mockScopedDb: vi.fn(() => ({ predicate })),
    mockAccessFrom: vi.fn((ctx: unknown) => ({ __access: ctx })),
    // Facet-slug resolver — canonical visibility-scoped read. Default: no
    // facets (empty map) so kind-only tests are untouched.
    mockLoadFacetSlugsBatch: vi.fn(async () => new Map<string, string[]>()),
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
    loadFacetSlugsBatch: mockLoadFacetSlugsBatch,
    and: vi.fn((...conditions) => ({ and: conditions.filter(Boolean) })),
    or: vi.fn((...conditions) => ({ or: conditions.filter(Boolean) })),
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
    mockLoadFacetSlugsBatch.mockResolvedValue(new Map<string, string[]>());
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

    // WHERE composes the visibility predicate + status='active' + an OR of
    // scalar `subject_profile->>'profileSlug' = <slug>` comparisons. With no
    // entityId the match set is just the requested kind slug: OR(= "post").
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __visibility: true });
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
    expect(where.and).toContainEqual(
      expect.objectContaining({
        or: expect.arrayContaining([
          expect.objectContaining({ values: expect.arrayContaining(["post"]) }),
        ]),
      })
    );

    // No entityId → no facet resolution.
    expect(mockLoadFacetSlugsBatch).not.toHaveBeenCalled();
  });

  it("widens the match set with an entity's facet-role slugs when entityId is given", async () => {
    // The captured entity is a `person` (kind) wearing a `lead` role-facet.
    // A playbook whose subject is the facet role (`Enrich this lead`) must now
    // surface even though the caller passes only the KIND slug.
    const ENTITY = "00000000-0000-4000-8000-0000000000aa";
    mockLoadFacetSlugsBatch.mockResolvedValue(
      new Map<string, string[]>([[ENTITY, ["lead"]]])
    );
    const chain = selectChain([
      {
        id: "pb-lead",
        name: "Enrich this lead",
        goalTemplate: "Enrich {{subject}}",
        params: [],
        executor: "is-agent",
        subjectProfile: { profileSlug: "lead" },
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "person",
      entityId: ENTITY,
      workspaceId: WORKSPACE,
    });

    // The facet-subject playbook surfaces via the widened match set.
    expect(result).toEqual([
      {
        id: "pb-lead",
        name: "Enrich this lead",
        goalTemplate: "Enrich {{subject}}",
        subjectProfileSlug: "lead",
        params: [],
        executor: "is-agent",
      },
    ]);

    // Facets resolved through the canonical visibility-scoped door, with the
    // caller's workspace lens + user floor.
    expect(mockLoadFacetSlugsBatch).toHaveBeenCalledWith(
      expect.anything(),
      [ENTITY],
      { userId: "user-1", workspaceId: WORKSPACE }
    );

    // WHERE matches ANY of {kind slug, facet slugs} = ["person", "lead"] via an
    // OR of scalar `=` comparisons (one per slug).
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual(
      expect.objectContaining({
        or: expect.arrayContaining([
          expect.objectContaining({
            values: expect.arrayContaining(["person"]),
          }),
          expect.objectContaining({ values: expect.arrayContaining(["lead"]) }),
        ]),
      })
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
