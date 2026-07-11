/**
 * Unit test for the write door — scopedDb(access).mutate(table).
 *
 * Proves the three load-bearing guarantees WITHOUT a live DB: the DB write
 * methods and `getWorkspaceMembership` are mocked, and the target row is served
 * from a fake registered table whose relational-query thunk we control.
 *
 *   1. an UNREGISTERED table throws (declaration-or-throw, same as reads);
 *   2. a row in a workspace the caller is NOT an editor+ of is DENIED (and no
 *      write is issued);
 *   3. an owned / member row SUCCEEDS (the write is issued).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted so the vi.mock factory (also hoisted) can close over them.
const { updateSpy, deleteSpy, insertSpy, membershipMock } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  deleteSpy: vi.fn(),
  insertSpy: vi.fn(),
  membershipMock: vi.fn(),
}));

// Partial mock: keep the real schema/exports, stub only the write surface and
// the membership lookup so no Postgres connection is ever opened.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceMembership: membershipMock,
    db: {
      update: () => ({
        set: () => ({
          where: (...a: unknown[]) => {
            updateSpy(...a);
            return Promise.resolve();
          },
        }),
      }),
      delete: () => ({
        where: (...a: unknown[]) => {
          deleteSpy(...a);
          return Promise.resolve();
        },
      }),
      insert: () => ({
        values: (...a: unknown[]) => {
          insertSpy(...a);
          return Promise.resolve();
        },
      }),
    },
  };
});

import { entities } from "@synap/database/schema";
import { AccessContext, scopedDb, registerVisibility } from "./index.js";

// A fake scoped table: borrows real Drizzle columns (so `eq(t.id, …)` builds a
// valid SQL node) while its query thunk serves a row WE control per-test.
let currentRow: Record<string, unknown> | undefined;
const fakeTable = {
  id: entities.id,
  workspaceId: entities.workspaceId,
  userId: entities.userId,
};
registerVisibility({
  table: fakeTable,
  query: () => ({
    findFirst: async () => currentRow,
    findMany: async () => [],
  }),
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: entities.workspaceId,
    userColumn: entities.userId,
  },
});

const op = AccessContext.operator({ userId: "u1" });

beforeEach(() => {
  vi.clearAllMocks();
  currentRow = undefined;
});

describe("scopedDb().mutate — declaration-or-throw", () => {
  it("throws constructing a mutation on an UNREGISTERED table", () => {
    expect(() => scopedDb(op).mutate({})).toThrow(/not registered/);
  });
});

describe("scopedDb().mutate — the write gate keys on the loaded row", () => {
  it("DENIES an update to a row in a workspace the caller is not a member of", async () => {
    currentRow = { workspaceId: "ws-other", userId: "someone-else" };
    membershipMock.mockResolvedValue(null); // caller is not a member

    await expect(
      scopedDb(op).mutate(fakeTable).update("id-1", { name: "x" })
    ).rejects.toThrow(/not a member/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("DENIES an update when the caller is a member but only below editor", async () => {
    currentRow = { workspaceId: "ws-1", userId: "someone-else" };
    membershipMock.mockResolvedValue({ role: "viewer" });

    await expect(
      scopedDb(op).mutate(fakeTable).update("id-1", { name: "x" })
    ).rejects.toThrow(/not a member/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS an update to a row in a workspace the caller is an editor+ of", async () => {
    currentRow = { workspaceId: "ws-1", userId: "someone-else" };
    membershipMock.mockResolvedValue({ role: "editor" });

    await scopedDb(op).mutate(fakeTable).update("id-1", { name: "x" });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("ALLOWS an update to the caller's OWN pod-wide (NULL-workspace) row", async () => {
    currentRow = { workspaceId: null, userId: "u1" };

    await scopedDb(op).mutate(fakeTable).update("id-1", { name: "x" });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    // Pod-wide/owned path is gated on ownerId, never touches membership.
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it("DENIES an update to someone else's pod-wide row", async () => {
    currentRow = { workspaceId: null, userId: "someone-else" };

    await expect(
      scopedDb(op).mutate(fakeTable).update("id-1", { name: "x" })
    ).rejects.toThrow(/owner/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the target row does not exist", async () => {
    currentRow = undefined;
    await expect(
      scopedDb(op).mutate(fakeTable).update("missing", { name: "x" })
    ).rejects.toThrow(/not found/i);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("gates delete on the loaded row the same way as update", async () => {
    currentRow = { workspaceId: "ws-1", userId: "someone-else" };
    membershipMock.mockResolvedValue({ role: "admin" });

    await scopedDb(op).mutate(fakeTable).delete("id-1");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("gates insert on the row's TARGET workspace", async () => {
    membershipMock.mockResolvedValue({ role: "editor" });
    await scopedDb(op).mutate(fakeTable).insert({
      workspaceId: "ws-1",
      userId: "u1",
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);

    // A workspace the caller is not in is denied — no insert issued.
    vi.clearAllMocks();
    membershipMock.mockResolvedValue(null);
    await expect(
      scopedDb(op)
        .mutate(fakeTable)
        .insert({ workspaceId: "ws-x", userId: "u1" })
    ).rejects.toThrow(/not a member/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
