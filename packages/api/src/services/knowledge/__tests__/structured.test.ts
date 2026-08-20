/**
 * structured.ts — scoping contract tests (S3 debt).
 *
 * `structuredLookup` composes the WHERE for the enumerative knowledge lane. Its
 * scope is security-load-bearing, so this pins the three invariants without a
 * live DB: every drizzle helper + access door is mocked to a tagged sentinel and
 * `db.query.entities.findMany` captures the composed `where`, which we then
 * assert on.
 *
 * Invariants:
 *   1. The user floor is ALWAYS intersected (a floor door is always AND-ed in).
 *   2. `includeGlobals` is passed (ORs pod-wide `workspaceId IS NULL` rows) on the
 *      no-project lane — pod-scoped kinds must never be hidden by a workspace lens.
 *   3. The status filter is applied ONLY for the `task` profile (and only when the
 *      spoken word maps to a seeded enum).
 *
 * Vitest hoisting: `vi.mock` factories are hoisted above module-level bindings,
 * so the capture holder is declared via `vi.hoisted`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  captured: {
    where: undefined as any,
    /** Args the facet-scope door was called with (see the pod-wide suite). */
    facetScopeArgs: undefined as
      { userId: string; workspaceId: unknown } | undefined,
  },
  /** Rows `profileSlugRows` resolves to — emptied to test the fail-closed door. */
  slugRows: [{ id: "kind-1", profileKind: "kind" as const }] as Array<{
    id: string;
    profileKind: "kind" | "role";
  }>,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      entities: {
        findMany: async (args: any) => {
          h.captured.where = args?.where;
          return [];
        },
      },
    },
  },
  entities: {
    id: { _col: "id" },
    workspaceId: { _col: "workspace_id" },
    userId: { _col: "user_id" },
    deletedAt: { _col: "deleted_at" },
    properties: { _col: "properties" },
    createdAt: { _col: "created_at" },
  },
  and: (...args: unknown[]) => ({ _tag: "and", args }),
  isNull: (col: unknown) => ({ _tag: "isNull", col }),
  desc: (col: unknown) => ({ _tag: "desc", col }),
  drizzleSql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    _tag: "sql",
    strings: [...strings],
    vals,
  }),
  profileSlugScopeConditionFromRows: (
    _db: unknown,
    slug: string,
    _rows: unknown
  ) => ({
    _tag: "profileSlugScope",
    slug,
  }),
  // `structuredLookup` now fails closed on a slug this pod has no profile for
  // (assertKnownProfileSlug → profileSlugRows). These scoping tests all use a
  // slug that EXISTS, so the stub returns one kind row; the assert passes and
  // the composed-WHERE invariants below are what's under test.
  profileSlugRows: async (_db: unknown, _slug: string) => h.slugRows,
}));

vi.mock("../../../utils/user-visible-where.js", () => ({
  workspaceLensWhere: (
    col: unknown,
    userId: string,
    wsId: unknown,
    opts: unknown
  ) => ({ _tag: "workspaceLensWhere", col, userId, wsId, opts }),
}));

vi.mock("../../../utils/project-scope.js", () => ({
  accessScopeWhere: (args: unknown) => ({ _tag: "accessScopeWhere", args }),
  projectLensWhere: (col: unknown, projectId: unknown) => ({
    _tag: "projectLensWhere",
    col,
    projectId,
  }),
}));

vi.mock("../../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async (userId: string, workspaceId: unknown) => {
    h.captured.facetScopeArgs = { userId, workspaceId };
    return { _tag: "facetScope" };
  },
}));

import { structuredLookup } from "../structured.js";

const USER = "user-1";
const conditionsOf = () => (h.captured.where?.args ?? []) as any[];
const hasTag = (tag: string) => conditionsOf().some((c) => c?._tag === tag);

beforeEach(() => {
  h.captured.where = undefined;
  h.captured.facetScopeArgs = undefined;
  h.slugRows = [{ id: "kind-1", profileKind: "kind" }];
});

describe("structuredLookup — fails closed on unknown vocabulary", () => {
  it("throws instead of returning [] when the slug names no profile", async () => {
    // The defect this closes: the shared scope predicate falls back to a
    // row-blind `entities.type` match for an unresolvable slug, so the lane
    // answered "you have none" to a question about vocabulary that does not
    // exist in this pod — indistinguishable from a genuinely empty result.
    h.slugRows = [];
    await expect(
      structuredLookup({
        profileSlug: "crm-lead",
        userId: USER,
        workspaceId: "ws-1",
        limit: 10,
      })
    ).rejects.toThrow(/Unknown profile: "crm-lead"/);
    // and it must not have run the query at all
    expect(h.captured.where).toBeUndefined();
  });

  it("proceeds normally when the slug resolves", async () => {
    await structuredLookup({
      profileSlug: "company",
      userId: USER,
      workspaceId: "ws-1",
      limit: 10,
    });
    expect(h.captured.where?._tag).toBe("and");
  });
});

describe("structuredLookup — floor is always intersected", () => {
  // The no-project lane used to floor on bare `workspaceLensWhere`, whose
  // `userVisibleWhere` NULL clause treats `workspace_id IS NULL` as pod-wide
  // -visible-to-ALL. For `entities` a NULL workspace means owner-PRIVATE, so
  // that leaked every user's pod-wide entities. It now floors on
  // `accessScopeWhere`, whose pod-personal branch gates NULL rows to their
  // owner. This test asserts the SECURE shape and, just as importantly, that
  // the leaky one has not come back.
  it("no-project lane: uses the accessScopeWhere floor, AND-ed at the top", async () => {
    await structuredLookup({
      profileSlug: "company",
      userId: USER,
      workspaceId: "ws-1",
      limit: 10,
    });
    expect(h.captured.where?._tag).toBe("and");
    expect(hasTag("accessScopeWhere")).toBe(true);
    expect(hasTag("workspaceLensWhere")).toBe(false);
    // The polymorphic type match is always present too.
    expect(hasTag("profileSlugScope")).toBe(true);
  });

  it("project lane: uses the accessScopeWhere floor + a project narrow", async () => {
    await structuredLookup({
      profileSlug: "company",
      userId: USER,
      projectId: "proj-1",
      limit: 10,
    });
    expect(h.captured.where?._tag).toBe("and");
    expect(hasTag("accessScopeWhere")).toBe(true);
    expect(hasTag("projectLensWhere")).toBe(true);
  });
});

describe("structuredLookup — includeGlobals ORs pod-wide rows", () => {
  // `includeGlobalsInLens` is accessScopeWhere's name for what the old floor
  // called `includeGlobals: true` — surface pod-wide globals under a lens. The
  // capability is unchanged; only the door it is passed through moved.
  it("passes includeGlobalsInLens:true to the access floor (no-project lane)", async () => {
    await structuredLookup({
      profileSlug: "task",
      userId: USER,
      workspaceId: "ws-1",
      limit: 10,
    });
    const floor = conditionsOf().find((c) => c?._tag === "accessScopeWhere");
    // The stub captures the call's single options object as `args`.
    expect(floor?.args).toMatchObject({
      includeGlobalsInLens: true,
      workspaceLens: "ws-1",
    });
  });
});

describe("structuredLookup — status filter only for task", () => {
  it("task + a mappable word → a status sql condition is added", async () => {
    await structuredLookup({
      profileSlug: "task",
      userId: USER,
      status: "open",
      limit: 10,
    });
    expect(hasTag("sql")).toBe(true);
  });

  it("non-task profile + a status word → NO status condition", async () => {
    await structuredLookup({
      profileSlug: "company",
      userId: USER,
      status: "open",
      limit: 10,
    });
    expect(hasTag("sql")).toBe(false);
  });

  it("task + an unmappable word → NO status condition (honest all-rows)", async () => {
    await structuredLookup({
      profileSlug: "task",
      userId: USER,
      status: "nonsense-word",
      limit: 10,
    });
    expect(hasTag("sql")).toBe(false);
  });
});

/**
 * Pod-wide role enumeration — the "no lens" vocabulary fork.
 *
 * Live defect (team pod, 2026-08-19): `synap ask "list our clients"` pod-wide
 * routed to `structured` and returned ZERO rows over a pod holding 20 `client`
 * role-facets, so synthesis honestly reported "none are explicitly labeled as
 * clients". Pod-wide "list our companies" (a KIND slug, no facet predicate)
 * returned 200 rows on the same call shape — only the facet branch differed.
 *
 * Cause: `ask`'s hub route defaults an unpinned query to `workspaceId = null`
 * meaning "no lens". `resolveFacetVisibilityScope` reads `null` as its own
 * NARROWER thing — "pod-wide roles only" → `isNull(entity_facets.workspace_id)`
 * — so every facet attached under a real workspace was excluded, while the
 * ENTITY half (which already coerced `workspaceId ?? undefined`) stayed
 * identity-wide. The two halves of one query disagreed about "no lens".
 */
describe("structuredLookup — pod-wide (null lens) role enumeration", () => {
  it("forwards a null lens to the facet door as undefined, not null", async () => {
    await structuredLookup({
      profileSlug: "client",
      userId: USER,
      workspaceId: null,
      limit: 200,
    });
    // `undefined` = identity-wide floor (allowedWorkspaceIds). `null` would
    // mean pod-wide-facets-only and drop every workspace-attached role.
    expect(h.captured.facetScopeArgs?.workspaceId).toBeUndefined();
    expect(h.captured.facetScopeArgs?.userId).toBe(USER);
  });

  it("treats an omitted lens the same as an explicit null lens", async () => {
    await structuredLookup({
      profileSlug: "client",
      userId: USER,
      limit: 200,
    });
    expect(h.captured.facetScopeArgs?.workspaceId).toBeUndefined();
  });

  it("still passes a concrete lens through untouched", async () => {
    await structuredLookup({
      profileSlug: "client",
      userId: USER,
      workspaceId: "ws-1",
      limit: 200,
    });
    expect(h.captured.facetScopeArgs?.workspaceId).toBe("ws-1");
  });

  it("suppresses the workspace lens on the project lane (unchanged)", async () => {
    await structuredLookup({
      profileSlug: "client",
      userId: USER,
      workspaceId: "ws-1",
      projectId: "proj-1",
      limit: 200,
    });
    expect(h.captured.facetScopeArgs?.workspaceId).toBeUndefined();
  });
});
