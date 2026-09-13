import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `disconnectConnection` — an admin disconnecting a MEMBER's connection
 *.
 *
 * The broker namespaces connections per user. Revoking under the admin's own id
 * found nothing, the 404 read as success, the registry rows were deleted, the
 * Nango connection lived on, and the owner's next list re-mirrored it. The fix:
 * revoke AS THE ROW'S OWNER, and a revoke that did not happen keeps the rows.
 *
 * The fake broker enforces the namespace exactly like the CP: a revoke under any
 * user but the owner throws `BrokerConnectionNotFoundError`.
 */

const h = vi.hoisted(() => ({
  persisted: [] as Array<{ userId: string; isPodWide: boolean }>,
  liveByUser: {} as Record<
    string,
    Array<{ connectionId: string; provider: string }>
  >,
  revokes: [] as Array<{ connectionId: string; pck?: string; userId: string }>,
  detached: [] as string[],
  revokeError: null as Error | null,
}));

vi.mock("../../connectors/index.js", async () => {
  const { BrokerConnectionNotFoundError } =
    await import("../../connectors/CpBrokerConnector.js");
  return {
    resolveBroker: async () => ({
      ok: true,
      source: "control-plane",
      broker: {
        mode: "cp",
        listConnectionsResult: async (userId: string) => ({
          ok: true,
          connections: (h.liveByUser[userId] ?? []).map((c) => ({
            ...c,
            userId,
            createdAt: new Date(),
          })),
        }),
        revokeConnection: async (
          connectionId: string,
          pck: string | undefined,
          userId: string
        ) => {
          h.revokes.push({ connectionId, pck, userId });
          if (h.revokeError) throw h.revokeError;
          const owned = (h.liveByUser[userId] ?? []).some(
            (c) => c.connectionId === connectionId
          );
          if (!owned) {
            throw new BrokerConnectionNotFoundError(
              `${connectionId} not in ${userId}'s namespace`
            );
          }
        },
      },
    }),
  };
});

vi.mock("./capability-nango-sync.js", () => ({
  syncNangoConnectionsToRegistry: vi.fn(async () => undefined),
  detachNangoConnectionRegistry: vi.fn(async (id: string) => {
    h.detached.push(id);
  }),
}));

vi.mock("../../utils/workspace-role.js", () => ({
  requirePodAdmin: vi.fn(async () => undefined),
  isPodAdmin: vi.fn(async () => true),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => ({ from: () => ({ where: async () => h.persisted }) }),
  },
}));

import { disconnectConnection } from "./capability-connections.js";

beforeEach(() => {
  h.persisted = [{ userId: "member-1", isPodWide: false }];
  h.liveByUser = {
    "member-1": [{ connectionId: "conn-1", provider: "google" }],
  };
  h.revokes = [];
  h.detached = [];
  h.revokeError = null;
});

const input = {
  capabilityId: "cap-1",
  connectionId: "conn-1",
  actorUserId: "admin-1",
};

describe("disconnectConnection — admin disconnects a member's connection", () => {
  it("revokes AS THE OWNER (not the admin), then detaches", async () => {
    await expect(disconnectConnection(input)).resolves.toMatchObject({
      ok: true,
      provider: "google",
    });
    expect(h.revokes).toEqual([
      { connectionId: "conn-1", pck: "google", userId: "member-1" },
    ]);
    expect(h.detached).toEqual(["conn-1"]);
  });

  it("a revoke that did not happen KEEPS the registry rows and surfaces the error", async () => {
    h.revokeError = new Error("broker down");
    await expect(disconnectConnection(input)).rejects.toThrow("broker down");
    expect(h.detached).toEqual([]);
  });

  it("when the owner's broker no longer has it, only the registry footprint is cleaned", async () => {
    h.liveByUser = {};
    await expect(disconnectConnection(input)).resolves.toMatchObject({
      ok: true,
      provider: null,
    });
    expect(h.revokes).toEqual([]);
    expect(h.detached).toEqual(["conn-1"]);
  });

  it("a member disconnecting their own connection revokes as themselves", async () => {
    await disconnectConnection({ ...input, actorUserId: "member-1" });
    expect(h.revokes).toEqual([
      { connectionId: "conn-1", pck: "google", userId: "member-1" },
    ]);
  });
});
