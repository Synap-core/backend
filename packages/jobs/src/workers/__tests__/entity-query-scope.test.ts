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
 *     (b) pod-wide (workspace_id NULL) rows owned by the run owner,
 *   but NEVER
 *     (c) workspace B's rows, nor
 *     (d) another user's pod-wide rows.
 *
 * (c) is the cross-workspace-leak guard — the invariant this whole change must
 * not break.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock @synap/database — only the surface entity-query-scope.ts imports:
// { and, or, eq, isNull, entities }. Helpers return tagged nodes the interpreter
// below understands; `entities` exposes the two columns the predicate reads.
vi.mock("@synap/database", () => ({
  and: (...args: unknown[]) => ({ _tag: "and", args }),
  or: (...args: unknown[]) => ({ _tag: "or", args }),
  eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
  isNull: (col: unknown) => ({ _tag: "isNull", col }),
  entities: {
    workspaceId: { _colName: "workspace_id" },
    userId: { _colName: "user_id" },
  },
}));

import { entityQueryVisibilityWhere } from "../entity-query-scope.js";

// ── Tiny interpreter: evaluate a tagged predicate tree against a row. ──────────
// A row is { workspace_id, user_id }; a column stub carries `_colName`.
type Row = { workspace_id: string | null; user_id: string };
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

  it("still owner-floors — no other user's pod-wide rows", () => {
    expect(evalPredicate(where, rowPodOther)).toBe(false);
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
