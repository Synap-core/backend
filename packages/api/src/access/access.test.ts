import { describe, it, expect } from "vitest";
import { entities, entityTemplates, channels } from "@synap/database/schema";
import {
  AccessContext,
  visibilityPredicate,
  getVisibilityEntry,
  isRegistered,
} from "./index.js";
// withVisibility is an internal composer (not part of the public barrel).
import { withVisibility } from "./visibility.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { accessScopeWhere } from "../utils/project-scope.js";

describe("AccessContext — the two boundary factories", () => {
  it("operator() builds a non-agent context", () => {
    const a = AccessContext.operator({ userId: "u1" });
    expect(a.userId).toBe("u1");
    expect(a.actor).toBe("operator");
    expect(a.isAgent).toBe(false);
    expect(a.agentUserId).toBeUndefined();
  });

  it("operator() throws without an authenticated userId", () => {
    expect(() => AccessContext.operator({ userId: null })).toThrow();
    expect(() => AccessContext.operator({ userId: undefined })).toThrow();
  });

  it("agent() with an agentUserId is an agent action (the AI discriminator)", () => {
    const a = AccessContext.agent({ userId: "owner", agentUserId: "ag1" });
    expect(a.isAgent).toBe(true);
    expect(a.actor).toBe("agent");
    expect(a.agentUserId).toBe("ag1");
  });

  it("agent() WITHOUT an agentUserId is treated as operator (mirrors the gate)", () => {
    const a = AccessContext.agent({ userId: "owner" });
    expect(a.isAgent).toBe(false);
    expect(a.actor).toBe("operator");
  });

  it("agent() throws without an authenticated userId", () => {
    expect(() =>
      AccessContext.agent({ userId: null, agentUserId: "ag1" })
    ).toThrow();
  });
});

describe("visibilityPredicate — one rule per scoping shape", () => {
  const op = AccessContext.operator({ userId: "u1" });

  it("podWide → no restriction (undefined)", () => {
    expect(visibilityPredicate({ kind: "podWide" }, op)).toBeUndefined();
  });

  it("user → a defined predicate", () => {
    const p = visibilityPredicate(
      { kind: "user", userColumn: entityTemplates.userId },
      op
    );
    expect(p).toBeDefined();
  });

  it("workspace → a defined predicate", () => {
    const p = visibilityPredicate(
      { kind: "workspace", workspaceColumn: entities.workspaceId },
      op
    );
    expect(p).toBeDefined();
  });

  it("workspace rule is defined in all three lens states (user-wide / globals / narrowed)", () => {
    const rule = {
      kind: "workspace" as const,
      workspaceColumn: entities.workspaceId,
    };
    expect(visibilityPredicate(rule, op.withLens(undefined))).toBeDefined();
    expect(visibilityPredicate(rule, op.withLens(null))).toBeDefined();
    expect(visibilityPredicate(rule, op.withLens("ws-1"))).toBeDefined();
  });

  it("workspace rule with a focused lens is defined with and without includeGlobalsInLens", () => {
    const focused = op.withLens("ws-1");
    // default: focused workspace only (globals excluded)
    expect(
      visibilityPredicate(
        { kind: "workspace", workspaceColumn: entities.workspaceId },
        focused
      )
    ).toBeDefined();
    // substrate opt-in: globals stay visible inside the focused workspace
    expect(
      visibilityPredicate(
        {
          kind: "workspace",
          workspaceColumn: entities.workspaceId,
          includeGlobalsInLens: true,
        },
        focused
      )
    ).toBeDefined();
  });

  it("workspaceOwned → a defined predicate (user floor AND workspace lens)", () => {
    const p = visibilityPredicate(
      {
        kind: "workspaceOwned",
        workspaceColumn: entities.workspaceId,
        userColumn: entities.userId,
      },
      op
    );
    expect(p).toBeDefined();
  });

  it("custom → receives the AccessContext and returns its predicate", () => {
    let seen: AccessContext | undefined;
    const sentinel = visibilityPredicate(
      {
        kind: "custom",
        predicate: (access) => {
          seen = access;
          return undefined;
        },
      },
      op
    );
    expect(seen).toBe(op);
    expect(sentinel).toBeUndefined();
  });
});

describe("AccessContext.withLens — the optional workspace lens", () => {
  const op = AccessContext.operator({ userId: "u1" });

  it("defaults to user-wide (undefined lens), preserving identity", () => {
    expect(op.workspaceLens).toBeUndefined();
  });

  it("withLens carries the 3-state lens without mutating identity", () => {
    expect(op.withLens("ws-1").workspaceLens).toBe("ws-1");
    expect(op.withLens(null).workspaceLens).toBeNull();
    expect(op.withLens(undefined).workspaceLens).toBeUndefined();
    // identity is preserved across the narrowing
    const lensed = op.withLens("ws-1");
    expect(lensed.userId).toBe("u1");
    expect(lensed.actor).toBe("operator");
  });

  it("withLens / withProjectLens accept a SET (multi-valued composable fetch)", () => {
    expect(op.withLens(["ws-1", "ws-2"]).workspaceLens).toEqual([
      "ws-1",
      "ws-2",
    ]);
    expect(op.withProjectLens(["p1", "p2"]).projectLens).toEqual(["p1", "p2"]);
    // both lenses compose, identity preserved
    const both = op.withLens(["ws-1"]).withProjectLens(["p1"]);
    expect(both.workspaceLens).toEqual(["ws-1"]);
    expect(both.projectLens).toEqual(["p1"]);
    expect(both.userId).toBe("u1");
  });
});

describe("lens predicates — multi-valued + empty-array=floor invariant", () => {
  it("workspaceLensWhere: array, single, null, undefined, [] all return a defined SQL", () => {
    const col = entities.workspaceId;
    // All four shapes produce a predicate (the floor for undefined/[]).
    expect(workspaceLensWhere(col, "u1")).toBeDefined(); // undefined → floor
    expect(workspaceLensWhere(col, "u1", [])).toBeDefined(); // [] → floor (NOT zero)
    expect(workspaceLensWhere(col, "u1", "ws-1")).toBeDefined();
    expect(workspaceLensWhere(col, "u1", ["ws-1", "ws-2"])).toBeDefined();
    expect(workspaceLensWhere(col, "u1", null)).toBeDefined();
  });

  it("accessScopeWhere: multi-valued workspace + project lenses compose to a defined SQL", () => {
    const sql = accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId: "u1",
      workspaceLens: ["ws-1", "ws-2"],
      projectLens: ["p1", "p2"],
    });
    expect(sql).toBeDefined();
    // Empty arrays = no narrow (the floor) — must not collapse to match-zero.
    const floor = accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId: "u1",
      workspaceLens: [],
      projectLens: [],
    });
    expect(floor).toBeDefined();
  });
});

describe("registry — declaration is mandatory", () => {
  it("a seeded table is registered (side-effect import ran)", () => {
    expect(isRegistered(channels)).toBe(true);
  });

  it("the converged DATA tables are registered (custom→accessScopeWhere)", () => {
    // entities/documents now declare a `custom` rule delegating to the canonical
    // DATA-table resolver, so a scopedDb read floors identically to the
    // hand-rolled entityVisibleWhere / documents.list path.
    expect(isRegistered(entities)).toBe(true);
  });

  it("a table with bespoke conditional scoping stays intentionally unregistered", () => {
    // entityTemplates keeps its own scoping (templates.list's conditional
    // includePublic semantics don't fit a uniform rule), so it's deliberately
    // absent — the registry holds only tables with a uniform declared rule.
    expect(isRegistered(entityTemplates)).toBe(false);
  });

  it("an unregistered table throws (the structural guarantee)", () => {
    expect(() => getVisibilityEntry({})).toThrow(/not registered/);
  });
});

describe("withVisibility — compose predicate with caller where", () => {
  const op = AccessContext.operator({ userId: "u1" });
  const pred = visibilityPredicate(
    { kind: "workspace", workspaceColumn: entities.workspaceId },
    op
  );

  it("predicate only → returns the predicate", () => {
    expect(withVisibility(pred, undefined)).toBe(pred);
  });

  it("both → returns a defined composed predicate", () => {
    expect(withVisibility(pred, pred)).toBeDefined();
  });

  it("neither → undefined", () => {
    expect(withVisibility(undefined, undefined)).toBeUndefined();
  });
});
