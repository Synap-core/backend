/**
 * buildIdentityResolveResponse — unit tests (no DB).
 *
 * This is the ONE place the cross-user content scoping happens for an
 * identity-resolve lookup (shared by the Hub REST /identity/resolve route and
 * the MCP synap_resolve_identity tool). The STRONG identity path is GLOBAL, so
 * a match may point at a row the caller can't see. The rule under test:
 *   - strong + INVISIBLE → keep the `match` verdict + `entityId` (so a caller
 *     can avoid creating a duplicate, and the governed write doors stay in
 *     charge) but STRIP title/kind — no content leak.
 *   - strong + VISIBLE → include title/kind.
 *
 * The visibility probe (`db.query.entities.findFirst`) is stubbed; the scoping
 * rule is the load-bearing logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));

vi.mock("@synap/database", () => ({
  db: { query: { entities: { findFirst: findFirstMock } } },
  entities: { id: {}, deletedAt: {}, workspaceId: {}, userId: {} },
}));
// ownerPrivateVisibleWhere only builds the (stubbed-away) `where` predicate —
// no-op it so this unit test doesn't pull in the workspace-membership query
// chain. The load-bearing logic under test is the findFirst-result → strip/keep
// branch, not the SQL the floor emits.
vi.mock("./user-visible-where.js", () => ({
  ownerPrivateVisibleWhere: vi.fn(() => ({})),
}));

import { buildIdentityResolveResponse } from "./identity-resolve-response.js";

type Resolution = Parameters<typeof buildIdentityResolveResponse>[0];

const strongResolution = (): Resolution =>
  ({
    match: "strong",
    entity: {
      id: "entity-1",
      title: "Alice's Private Contact",
      type: "person",
    },
    candidates: [],
  }) as unknown as Resolution;

describe("buildIdentityResolveResponse", () => {
  beforeEach(() => findFirstMock.mockReset());

  it("strong + INVISIBLE match → keeps match+entityId, strips title/kind", async () => {
    findFirstMock.mockResolvedValue(undefined); // not visible to caller
    const out = await buildIdentityResolveResponse(
      strongResolution(),
      "bob-user-id"
    );
    expect(out.match).toBe("strong");
    expect(out.entityId).toBe("entity-1");
    expect(out.entityTitle).toBeUndefined();
    expect(out.entityKind).toBeUndefined();
  });

  it("strong + VISIBLE match → includes title/kind", async () => {
    findFirstMock.mockResolvedValue({ id: "entity-1" }); // visible
    const out = await buildIdentityResolveResponse(
      strongResolution(),
      "alice-user-id"
    );
    expect(out.match).toBe("strong");
    expect(out.entityId).toBe("entity-1");
    expect(out.entityTitle).toBe("Alice's Private Contact");
    expect(out.entityKind).toBe("person");
  });

  it("weak-path candidates are passed through (already caller-scoped by the resolver)", async () => {
    const resolution = {
      match: "weak",
      entity: undefined,
      candidates: [{ id: "c1", title: "Cand One", type: "company" }],
    } as unknown as Resolution;
    const out = await buildIdentityResolveResponse(resolution, "any-user");
    expect(out.match).toBe("weak");
    // No strong entity → no visibility probe fired.
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(out.candidates).toEqual([
      { entityId: "c1", title: "Cand One", kind: "company" },
    ]);
  });
});
