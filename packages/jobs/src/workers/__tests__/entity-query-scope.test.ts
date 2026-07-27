/**
 * entity-query-scope.ts — unit tests (the SECURITY-critical visibility proof).
 *
 * No live DB: `@synap/database`'s drizzle helpers are mocked to return tagged
 * boolean-tree nodes, and a ~15-line interpreter (`evalPredicate`) evaluates the
 * REAL predicate the code builds against sample rows. That makes this a
 * row-level semantic proof — not just a structural one:
 *
 *   A `query` node in workspace A must return
 *     (a) A's own matching rows          AND
 *     (b) pod-wide (workspace_id NULL) rows owned by the run owner, AND
 *     (e) pod-wide rows SHARED to the pod (they carry a live pod-wide facet)
 *         when the run owner is a pod member  [Wave 2],
 *   but NEVER
 *     (c) workspace B's rows, nor
 *     (d) another user's UNSHARED pod-wide rows.
 *
 * (c) is the cross-workspace-leak guard — the invariant this whole change must
 * not break.
 */

import { describe, it, expect, vi } from "vitest";

// Pod-membership fixture — the mocked `podMemberWhere` consults this, so the
// row-independent EXISTS is modelled as the caller-keyed fact it actually is.
const POD_MEMBERS = new Set(["owner-1"]);

// ── Mock @synap/database — only the surface entity-query-scope.ts imports:
// { and, or, eq, isNull, inArray, db, entities, entityFacets, podMemberWhere }.
// Helpers return tagged nodes the interpreter below understands; `entities`
// exposes the three columns the predicate reads. The pod-wide-facet subquery is
// modelled as an opaque marker (`db.select().from().where()`), and matching it
// with `inArray(entities.id, …)` is the row's `has_pod_wide_facet` flag.
const FACET_SUBQUERY = { _sub: "podWideFacetEntityIds" };
vi.mock("@synap/database", () => ({
  and: (...args: unknown[]) => ({ _tag: "and", args }),
  or: (...args: unknown[]) => ({ _tag: "or", args }),
  eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
  isNull: (col: unknown) => ({ _tag: "isNull", col }),
  inArray: (col: unknown, sub: unknown) => ({ _tag: "inArray", col, sub }),
  podMemberWhere: (userId: string) => ({ _tag: "podMember", userId }),
  db: {
    select: () => ({
      from: () => ({ where: () => ({ _sub: "podWideFacetEntityIds" }) }),
    }),
  },
  entities: {
    id: { _colName: "id" },
    workspaceId: { _colName: "workspace_id" },
    userId: { _colName: "user_id" },
  },
  entityFacets: {
    entityId: { _colName: "entity_id" },
    workspaceId: { _colName: "workspace_id" },
    deletedAt: { _colName: "deleted_at" },
  },
}));

import { entityQueryVisibilityWhere } from "../entity-query-scope.js";

// ── Tiny interpreter: evaluate a tagged predicate tree against a row. ──────────
// A row is { workspace_id, user_id, has_pod_wide_facet }; a column stub carries
// `_colName`.
type Row = {
  workspace_id: string | null;
  user_id: string;
  /** Row is in the pod-wide-facet subquery = it carries a live pod-wide facet. */
  has_pod_wide_facet?: boolean;
};
type Node = any;

function evalPredicate(node: Node, row: Row): boolean {
  switch (node._tag) {
    case "and":
      return node.args.every((a: Node) => evalPredicate(a, row));
    case "or":
      return node.args.some((a: Node) => evalPredicate(a, row));
    case "eq":
      return row[node.col._colName as keyof Row] === node.val;
    case "isNull":
      return row[node.col._colName as keyof Row] === null;
    case "inArray":
      // The only subquery in this predicate is the pod-wide-facet entity-id set.
      if (node.sub?._sub !== FACET_SUBQUERY._sub) {
        throw new Error(`evalPredicate: unknown subquery ${node.sub?._sub}`);
      }
      return row.has_pod_wide_facet === true;
    case "podMember":
      // Row-INDEPENDENT: a fact about the caller, exactly like the SQL EXISTS.
      return POD_MEMBERS.has(node.userId);
    default:
      throw new Error(`evalPredicate: unhandled tag ${node?._tag}`);
  }
}

const WS_A = "ws-a";
const WS_B = "ws-b";
const OWNER = "owner-1";
const OTHER = "other-2";

// The five representative rows a workspace-A run could encounter.
const rowA: Row = { workspace_id: WS_A, user_id: OWNER }; // (a) A's own
const rowAOtherUser: Row = { workspace_id: WS_A, user_id: OTHER }; // A's, teammate-owned
const rowPodOwned: Row = { workspace_id: null, user_id: OWNER }; // (b) pod-wide, owned
const rowPodOther: Row = { workspace_id: null, user_id: OTHER }; // (d) pod-wide, other user
const rowB: Row = { workspace_id: WS_B, user_id: OWNER }; // (c) workspace B
// (e) pod-wide, another user's, but SHARED to the pod via a live pod-wide facet.
const rowPodOtherShared: Row = {
  workspace_id: null,
  user_id: OTHER,
  has_pod_wide_facet: true,
};
// A workspace-scoped row that happens to carry a pod-wide facet — the pod branch
// must still not admit it (it is guarded by workspace_id IS NULL).
const rowBFaceted: Row = {
  workspace_id: WS_B,
  user_id: OTHER,
  has_pod_wide_facet: true,
};

describe("entityQueryVisibilityWhere — default (workspace-lens union)", () => {
  const where = entityQueryVisibilityWhere({
    workspaceId: WS_A,
    ownerId: OWNER,
  });

  it("(a) returns this workspace's OWN rows", () => {
    expect(evalPredicate(where, rowA)).toBe(true);
  });

  it("(a') returns this workspace's rows regardless of owner (shared workspace data)", () => {
    // The workspace branch is not owner-floored — matches accessScopeWhere's
    // workspace floor branch (a member sees teammates' rows in the lens).
    expect(evalPredicate(where, rowAOtherUser)).toBe(true);
  });

  it("(b) returns pod-wide (workspace_id NULL) rows owned by the run owner — the bug fix", () => {
    expect(evalPredicate(where, rowPodOwned)).toBe(true);
  });

  it("(c) NEVER returns another workspace's rows — the cross-workspace-leak guard", () => {
    expect(evalPredicate(where, rowB)).toBe(false);
  });

  it("(d) NEVER returns another user's private pod-wide rows — the owner floor", () => {
    expect(evalPredicate(where, rowPodOther)).toBe(false);
  });

  it("(e) DOES return another user's pod-wide row when it is SHARED to the pod (Wave 2)", () => {
    expect(evalPredicate(where, rowPodOtherShared)).toBe(true);
  });

  it("(e') the pod-shared branch never admits a WORKSPACE-scoped row, facet or not", () => {
    expect(evalPredicate(where, rowBFaceted)).toBe(false);
  });
});

describe("entityQueryVisibilityWhere — pod-shared widening is membership-gated", () => {
  it("a NON-pod-member owner sees NO shared row — fail closed", () => {
    const nonMember = "stranger-9";
    expect(POD_MEMBERS.has(nonMember)).toBe(false);
    const where = entityQueryVisibilityWhere({
      workspaceId: WS_A,
      ownerId: nonMember,
    });
    expect(evalPredicate(where, rowPodOtherShared)).toBe(false);
    expect(evalPredicate(where, rowPodOther)).toBe(false);
    // …and their own workspace rows are unaffected.
    expect(evalPredicate(where, rowA)).toBe(true);
  });

  it("membership alone does not share an UN-faceted pod-wide row", () => {
    const where = entityQueryVisibilityWhere({
      workspaceId: WS_A,
      ownerId: OWNER,
    });
    expect(POD_MEMBERS.has(OWNER)).toBe(true);
    // rowPodOther is pod-wide and owned by someone else but carries NO pod-wide
    // facet → still private.
    expect(evalPredicate(where, rowPodOther)).toBe(false);
  });
});

describe("entityQueryVisibilityWhere — scope:'pod' (pod-wide only)", () => {
  const where = entityQueryVisibilityWhere({
    workspaceId: WS_A,
    ownerId: OWNER,
    podOnly: true,
  });

  it("returns pod-wide rows owned by the owner", () => {
    expect(evalPredicate(where, rowPodOwned)).toBe(true);
  });

  it("drops this workspace's own rows (pod-only narrow)", () => {
    expect(evalPredicate(where, rowA)).toBe(false);
  });

  it("still owner-floors — no other user's UNSHARED pod-wide rows", () => {
    expect(evalPredicate(where, rowPodOther)).toBe(false);
  });

  it("returns another member's pod-SHARED pod-wide row (Wave 2)", () => {
    expect(evalPredicate(where, rowPodOtherShared)).toBe(true);
  });

  it("never leaks another workspace's rows", () => {
    expect(evalPredicate(where, rowB)).toBe(false);
  });

  it("fails closed when the owner is unknown (never an un-floored NULL read)", () => {
    expect(() =>
      entityQueryVisibilityWhere({ workspaceId: WS_A, podOnly: true })
    ).toThrow("scope 'pod' requires an owner");
  });
});

describe("entityQueryVisibilityWhere — fail-closed default when owner unknown", () => {
  const where = entityQueryVisibilityWhere({ workspaceId: WS_A });

  it("returns this workspace's own rows", () => {
    expect(evalPredicate(where, rowA)).toBe(true);
  });

  it("does NOT return pod-wide rows (no owner floor available → drop the branch)", () => {
    expect(evalPredicate(where, rowPodOwned)).toBe(false);
    expect(evalPredicate(where, rowPodOther)).toBe(false);
  });

  it("does NOT return another workspace's rows", () => {
    expect(evalPredicate(where, rowB)).toBe(false);
  });
});
