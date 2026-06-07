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
});

describe("registry — declaration is mandatory", () => {
  it("a seeded table is registered (side-effect import ran)", () => {
    expect(isRegistered(channels)).toBe(true);
  });

  it("a scoped table NOT read through scopedDb is intentionally unregistered", () => {
    // entities uses its own scoping (workspaceProcedure / userVisibleWhere), so
    // it's deliberately absent — the registry holds only scopedDb-read tables.
    expect(isRegistered(entities)).toBe(false);
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
