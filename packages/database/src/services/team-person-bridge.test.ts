import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const userFind = vi.fn();
  const workspaceMemberFind = vi.fn();
  return {
    userFind,
    workspaceMemberFind,
    resolveIdentity: vi.fn(),
    registerIdentitySignals: vi.fn(),
    entityCreate: vi.fn(),
    facetAttach: vi.fn(),
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./identity-resolution-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./identity-resolution-service.js")>();
  return {
    ...actual,
    resolveIdentity: mocks.resolveIdentity,
    registerIdentitySignals: mocks.registerIdentitySignals,
  };
});

// The bridge constructs these repos with the transaction handle — stub them so
// the mocked db never needs a real create/attach implementation. Class form
// (not an arrow) so `new EntityRepository(...)` is constructable.
vi.mock("../repositories/entity-repository.js", () => ({
  EntityRepository: class {
    create = mocks.entityCreate;
  },
}));
vi.mock("../repositories/facet-repository.js", () => ({
  FacetRepository: class {
    attach = mocks.facetAttach;
  },
}));

// `userVisibleWhere` runs real drizzle query builders against `db` at call time;
// stub it to an opaque predicate so the weak-scope construction doesn't need a
// live connection.
vi.mock("../utils/user-visible-where.js", () => ({
  userVisibleWhere: vi.fn(() => ({ __sql: "user-visible" })),
}));

import {
  userExternalIdSignal,
  detachTeamMemberFacet,
  ensureTeamPersonForMember,
} from "./team-person-bridge.js";

function makeDb() {
  return {
    query: {
      users: { findFirst: mocks.userFind },
      workspaceMembers: { findFirst: mocks.workspaceMemberFind },
    },
    select: vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceMemberFind.mockResolvedValue(null);
  mocks.resolveIdentity.mockResolvedValue({
    match: null,
    candidates: [],
  });
  mocks.registerIdentitySignals.mockResolvedValue(undefined);
  mocks.entityCreate.mockResolvedValue({ id: "new-person" });
  mocks.facetAttach.mockResolvedValue(undefined);
});

/**
 * db mock for the ensure* path: a `transaction` that runs the callback against a
 * tx exposing `execute` (advisory lock), `query.entities.findFirst`, `update`,
 * plus the outer `query.users` / `query.workspaceMembers` lookups.
 */
function makeEnsureDb(entityFind = vi.fn().mockResolvedValue(undefined)) {
  const setWhere = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn(() => ({ set: () => ({ where: setWhere }) }));
  const execute = vi.fn().mockResolvedValue(undefined);
  const tx = {
    execute,
    update,
    query: { entities: { findFirst: entityFind } },
  };
  const db = {
    query: {
      users: { findFirst: mocks.userFind },
      workspaceMembers: { findFirst: mocks.workspaceMemberFind },
    },
    transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { db: db as never, tx, execute, update, setWhere, entityFind };
}

const HUMAN = {
  id: "user-1",
  email: "alice@example.com",
  name: "Alice",
  userType: "human" as const,
};

describe("userExternalIdSignal", () => {
  it("prefixes the user id with user:", () => {
    expect(userExternalIdSignal("abc-123")).toBe("user:abc-123");
  });

  it("is stable for empty string (caller responsibility to validate)", () => {
    expect(userExternalIdSignal("")).toBe("user:");
  });
});

describe("detachTeamMemberFacet", () => {
  it("returns user_not_found when member is missing", async () => {
    mocks.userFind.mockResolvedValue(undefined);

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "missing-user",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "user_not_found",
    });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it("skips agents", async () => {
    mocks.userFind.mockResolvedValue({
      id: "agent-1",
      email: "agent@example.com",
      name: "Bot",
      userType: "agent",
    });

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "agent-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "agent",
    });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it("returns no_person when identity resolve finds no person", async () => {
    mocks.userFind.mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      userType: "human",
    });
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    mocks.resolveIdentity.mockResolvedValue({
      match: null,
      candidates: [],
    });

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "no_person",
    });
    expect(mocks.resolveIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "owner-1",
        kindSlug: "person",
        signals: expect.arrayContaining([
          { type: "external_id", value: "user:user-1" },
          { type: "email", value: "alice@example.com" },
        ]),
      })
    );
  });

  it("never throws on unexpected errors", async () => {
    mocks.userFind.mockRejectedValue(new Error("db down"));

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "error",
    });
  });
});

describe("ensureTeamPersonForMember", () => {
  it("takes the per-member advisory lock before resolving/creating", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    const { db, execute } = makeEnsureDb();

    await ensureTeamPersonForMember(db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    // Serialization keystone: the lock is keyed on the login external_id.
    const lockArg = execute.mock.calls[0][0];
    expect(JSON.stringify(lockArg)).toContain(
      "synap:team-person-bridge:user:user-1"
    );
  });

  it("passes an owner-scoped userScope so the weak same-name path can run", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    const { db } = makeEnsureDb();

    await ensureTeamPersonForMember(db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(mocks.resolveIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "owner-1",
        kindSlug: "person",
        userScope: expect.anything(),
      })
    );
  });

  it("creates a person when nothing resolves", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    mocks.resolveIdentity.mockResolvedValue({ match: null, candidates: [] });
    const { db } = makeEnsureDb();

    const result = await ensureTeamPersonForMember(db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(mocks.entityCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ entityId: "new-person", action: "created" });
  });

  it("LINKS (no create) a same-name person whose email also matches", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    mocks.resolveIdentity.mockResolvedValue({
      match: "weak",
      entity: { id: "existing-1", title: "Alice", type: "person" },
      candidates: [{ id: "existing-1", title: "Alice", type: "person" }],
      crossKindCandidates: [],
    });
    // corroboration findFirst → email matches; merge findFirst → already linked.
    const entityFind = vi
      .fn()
      .mockResolvedValueOnce({
        properties: { email: "alice@example.com" },
      })
      .mockResolvedValueOnce({
        properties: { email: "alice@example.com", linkedUserId: "user-1" },
      });
    const { db } = makeEnsureDb(entityFind);

    const result = await ensureTeamPersonForMember(db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(mocks.entityCreate).not.toHaveBeenCalled();
    expect(result.entityId).toBe("existing-1");
    expect(["linked", "updated"]).toContain(result.action);
  });

  it("does NOT weak-link a same-name stranger with a different email — creates instead", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    mocks.resolveIdentity.mockResolvedValue({
      match: "weak",
      entity: { id: "stranger-1", title: "Alice", type: "person" },
      candidates: [{ id: "stranger-1", title: "Alice", type: "person" }],
      crossKindCandidates: [],
    });
    // corroboration findFirst → email is a DIFFERENT person.
    const entityFind = vi
      .fn()
      .mockResolvedValue({ properties: { email: "other@example.com" } });
    const { db } = makeEnsureDb(entityFind);

    const result = await ensureTeamPersonForMember(db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(mocks.entityCreate).toHaveBeenCalledTimes(1);
    expect(result.entityId).toBe("new-person");
    expect(result.action).toBe("created");
  });

  it("two ensures for the same user resolve to ONE person (post-lock strong re-resolve)", async () => {
    mocks.userFind.mockResolvedValue(HUMAN);
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });

    // First call: nothing resolves → creates person p1 (+ registers its signal).
    // Second call (serialized behind the lock): the external_id signal now
    // exists → strong match → LINK. Model that ordering with sequential mocks.
    mocks.resolveIdentity
      .mockResolvedValueOnce({ match: null, candidates: [] })
      .mockResolvedValueOnce({
        match: "strong",
        entity: { id: "new-person", title: "Alice", type: "person" },
        candidates: [],
        crossKindCandidates: [],
      });

    const first = await ensureTeamPersonForMember(makeEnsureDb().db, {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });
    const second = await ensureTeamPersonForMember(
      makeEnsureDb(
        vi.fn().mockResolvedValue({
          properties: { linkedUserId: "user-1" },
        })
      ).db,
      {
        memberUserId: "user-1",
        workspaceId: "ws-1",
        ownerUserId: "owner-1",
      }
    );

    // Exactly one row ever created across both calls.
    expect(mocks.entityCreate).toHaveBeenCalledTimes(1);
    expect(first.action).toBe("created");
    expect(second.action).toBe("updated");
    expect(first.entityId).toBe(second.entityId);
  });
});
