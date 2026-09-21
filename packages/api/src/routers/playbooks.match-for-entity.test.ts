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
    isNull: vi.fn((column) => ({ isNull: column })),
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

    // The candidate shape + the suggest-and-confirm ranking the door now
    // computes (`rankRouteCandidates`): built for the requested kind.
    expect(result).toEqual([
      {
        id: "pb-1",
        name: "Produce content from this idea",
        goalTemplate: "Produce content for {{platform}} from {{subject}}",
        subjectProfileSlug: "post",
        params: [{ key: "platform", type: "string" }],
        executor: "is-agent",
        score: 2,
        reason: "Made for post items",
        signals: [{ type: "kind", profileSlug: "post" }],
      },
    ]);

    // Scoping identical to `list`: scopedDb(AccessContext.from(ctx)).predicate.
    expect(mockAccessFrom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceId: WORKSPACE })
    );
    expect(mockScopedDb).toHaveBeenCalledTimes(1);
    expect(mockPredicate).toHaveBeenCalledTimes(1);

    // WHERE composes the visibility predicate + status='active' + an OR of
    // scalar `subject_profile->>'profileSlug' = <slug>` comparisons AND
    // `subjectProfile IS NULL` (null-subject playbooks stay in the pool).
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __visibility: true });
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
    expect(where.and).toContainEqual(
      expect.objectContaining({
        or: expect.arrayContaining([
          expect.objectContaining({ values: expect.arrayContaining(["post"]) }),
          expect.objectContaining({ isNull: expect.anything() }),
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

    // The facet-subject playbook surfaces via the widened match set, ranked as
    // a FACET match (not a kind match) — the facet slugs reach the ranker.
    expect(result).toEqual([
      {
        id: "pb-lead",
        name: "Enrich this lead",
        goalTemplate: "Enrich {{subject}}",
        subjectProfileSlug: "lead",
        params: [],
        executor: "is-agent",
        score: 1.5,
        reason: "Matches its lead role",
        signals: [{ type: "facet", profileSlug: "lead" }],
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

  it("with intentText, ranks the textual match FIRST through the real door and says why", async () => {
    // Matcher order is updatedAt desc — the textual match arrives SECOND, so a
    // door that ignored `intentText` would return it second.
    const chain = selectChain([
      {
        id: "pb-archive",
        name: "Archive old drafts",
        goalTemplate: "Move stale drafts away",
        params: [],
        executor: "is-agent",
        subjectProfile: { profileSlug: "post" },
      },
      {
        id: "pb-review",
        name: "Weekly review of posts",
        goalTemplate: "Read and triage what was saved",
        params: [],
        executor: "is-agent",
        subjectProfile: { profileSlug: "post" },
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "post",
      workspaceId: WORKSPACE,
      intentText: "review them weekly",
    });

    expect(result.map((r) => r.id)).toEqual(["pb-review", "pb-archive"]);
    expect(result[0]).toMatchObject({
      score: 8,
      reason: "You mentioned “review”, “weekly” · Made for post items",
      signals: [
        { type: "intent", terms: ["review", "weekly"] },
        { type: "kind", profileSlug: "post" },
      ],
    });
    expect(result[1]).toMatchObject({
      score: 2,
      reason: "Made for post items",
    });
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

  it("null-subject playbooks report subjectProfileSlug null (honest), not the requested slug", async () => {
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

    expect(candidate.subjectProfileSlug).toBeNull();
    expect(candidate.signals).toContainEqual({ type: "anyKind" });
  });

  it("no profileSlug + intent ranks a null-subject Plan Next Content playbook first", async () => {
    // Matcher order is updatedAt desc — Plan Next Content arrives SECOND, so a
    // door that ignored intentText (or only returned kind-matched rows) would
    // not put it first. The pool is every active visible playbook.
    const chain = selectChain([
      {
        id: "pb-produce",
        name: "Produce content from this idea",
        goalTemplate: "Produce content for {{platform}} from {{subject}}",
        params: [],
        executor: "is-agent",
        subjectProfile: { profileSlug: "post" },
      },
      {
        id: "pb-plan",
        name: "Plan Next Content",
        goalTemplate: "Decide what to publish next",
        params: [],
        executor: "is-agent",
        subjectProfile: null,
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      workspaceId: WORKSPACE,
      intentText: "what should I publish next",
    });

    // Zero-signal rows (Produce: no intent overlap, no kind without a slug) are
    // dropped so an intent-only match does not dump the whole catalog.
    expect(result.map((r) => r.id)).toEqual(["pb-plan"]);
    expect(result[0]).toMatchObject({
      name: "Plan Next Content",
      subjectProfileSlug: null,
    });
    expect(result[0]!.signals).toEqual(
      expect.arrayContaining([
        { type: "intent", terms: expect.arrayContaining(["publish", "next"]) },
        { type: "anyKind" },
      ])
    );

    // No kind/facet set → no subject-profile filter. The pool is every active
    // visible playbook (visibility + status), not only null-subject rows.
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toHaveLength(2);
    expect(where.and).toContainEqual({ __visibility: true });
    expect(where.and).toContainEqual(
      expect.objectContaining({ eq: expect.arrayContaining(["active"]) })
    );
  });

  it("with profileSlug post, both subject=post AND subject=null stay in the pool", async () => {
    const chain = selectChain([
      {
        id: "pb-produce",
        name: "Produce content from this idea",
        goalTemplate: "Produce content for {{platform}} from {{subject}}",
        params: [],
        executor: "is-agent",
        subjectProfile: { profileSlug: "post" },
      },
      {
        id: "pb-plan",
        name: "Plan Next Content",
        goalTemplate: "Decide what to publish next",
        params: [],
        executor: "is-agent",
        subjectProfile: null,
      },
    ]);
    mockGetDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = playbooksRouter.createCaller(callerCtx());
    const result = await caller.matchForEntity({
      profileSlug: "post",
      workspaceId: WORKSPACE,
    });

    expect(result.map((r) => r.id).sort()).toEqual(["pb-plan", "pb-produce"]);
    expect(result.find((r) => r.id === "pb-produce")).toMatchObject({
      subjectProfileSlug: "post",
      signals: [{ type: "kind", profileSlug: "post" }],
    });
    expect(result.find((r) => r.id === "pb-plan")).toMatchObject({
      name: "Plan Next Content",
      subjectProfileSlug: null,
      signals: [{ type: "anyKind" }],
    });

    // LOAD-BEARING: the WHERE must OR in `subjectProfile IS NULL`. Reverting
    // that clause is the negative control — this assertion is what fails.
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual(
      expect.objectContaining({
        or: expect.arrayContaining([
          expect.objectContaining({ values: expect.arrayContaining(["post"]) }),
          expect.objectContaining({ isNull: expect.anything() }),
        ]),
      })
    );
  });
});
