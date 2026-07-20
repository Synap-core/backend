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
  captured: { where: undefined as any },
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
  resolveFacetVisibilityScope: async () => ({ _tag: "facetScope" }),
}));

import { structuredLookup } from "../structured.js";

const USER = "user-1";
const conditionsOf = () => (h.captured.where?.args ?? []) as any[];
const hasTag = (tag: string) => conditionsOf().some((c) => c?._tag === tag);

beforeEach(() => {
  h.captured.where = undefined;
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
  it("no-project lane: uses workspaceLensWhere floor, AND-ed at the top", async () => {
    await structuredLookup({
      profileSlug: "company",
      userId: USER,
      workspaceId: "ws-1",
      limit: 10,
    });
    expect(h.captured.where?._tag).toBe("and");
    expect(hasTag("workspaceLensWhere")).toBe(true);
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
  it("passes includeGlobals:true to the workspace floor (no-project lane)", async () => {
    await structuredLookup({
      profileSlug: "task",
      userId: USER,
      workspaceId: "ws-1",
      limit: 10,
    });
    const floor = conditionsOf().find((c) => c?._tag === "workspaceLensWhere");
    expect(floor?.opts).toMatchObject({ includeGlobals: true });
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
