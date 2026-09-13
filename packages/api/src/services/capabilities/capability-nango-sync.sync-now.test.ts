import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `enqueueManualConnectionSync` — the door behind `connectors.syncNow`.
 *
 * The property: a user can only trigger syncs for their OWN connection registry
 * rows. The db mock returns rows WITHOUT applying the SQL filter, so the owner /
 * registry / liveness checks must hold in code — which is what these tests pin.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    userId: string;
    capabilityId: string | null;
    deletedAt: Date | null;
  }>,
  keysByCapability: {} as Record<string, string[]>,
  /** connectionId → the providers whose sync tool that row resolves to. */
  syncToolFor: {} as Record<string, string[]>,
  enqueued: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => ({ from: () => ({ where: async () => h.rows }) }),
  },
}));

vi.mock("./capability-provider-resolution.js", () => ({
  resolveCapabilityNangoProviderKeys: vi.fn(
    async (capabilityId: string) => h.keysByCapability[capabilityId] ?? []
  ),
}));

// The sync door's join (secrets.capabilityId → member_of → tool of that
// provider): a row syncs as a provider only when this resolves a tool.
vi.mock("../event-sync/sync-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSyncTool: vi.fn(
    async ({
      provider,
      connectionId,
    }: {
      provider: string;
      connectionId: string;
    }) =>
      (h.syncToolFor[connectionId] ?? []).includes(provider)
        ? {
            id: `tool-${provider}`,
            createdBy: "user-1",
            workspaceId: null,
            metadata: {},
          }
        : null
  ),
}));

vi.mock("../event-sync/connection-sync.js", () => ({
  enqueueConnectionSync: vi.fn(async (input: Record<string, unknown>) => {
    h.enqueued.push(input);
  }),
}));

import { enqueueManualConnectionSync } from "./capability-nango-sync.js";

beforeEach(() => {
  h.rows = [
    {
      id: "row-mine",
      userId: "user-1",
      capabilityId: "cap-google",
      deletedAt: null,
    },
    {
      id: "row-theirs",
      userId: "user-2",
      capabilityId: "cap-google",
      deletedAt: null,
    },
    {
      id: "row-deleted",
      userId: "user-1",
      capabilityId: "cap-google",
      deletedAt: new Date(),
    },
    { id: "row-vault", userId: "user-1", capabilityId: null, deletedAt: null },
  ];
  h.keysByCapability = { "cap-google": ["google"] };
  h.syncToolFor = {
    "row-mine": ["google"],
    "row-mine-2": ["google"],
    "row-theirs": ["google"],
    "row-deleted": ["google"],
  };
  h.enqueued = [];
});

describe("enqueueManualConnectionSync", () => {
  it("the owner's connectionId enqueues ONE manual sync with the derived provider", async () => {
    h.rows = h.rows.filter((r) => r.id === "row-mine");
    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      connectionId: "row-mine",
    });
    expect(r).toEqual({ ok: true, count: 1 });
    expect(h.enqueued).toEqual([
      {
        provider: "google",
        connectionId: "row-mine",
        workspaceId: null,
        reason: "manual",
      },
    ]);
  });

  it("ANOTHER user's connectionId is refused and nothing is enqueued", async () => {
    h.rows = h.rows.filter((r) => r.id === "row-theirs");
    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      connectionId: "row-theirs",
    });
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
    expect(h.enqueued).toEqual([]);
  });

  it("a deleted row and a non-registry row are refused", async () => {
    for (const id of ["row-deleted", "row-vault"]) {
      h.rows = [
        {
          id: "row-deleted",
          userId: "user-1",
          capabilityId: "cap-google",
          deletedAt: new Date(),
        },
        {
          id: "row-vault",
          userId: "user-1",
          capabilityId: null,
          deletedAt: null,
        },
      ].filter((r) => r.id === id);
      expect(
        await enqueueManualConnectionSync({
          userId: "user-1",
          connectionId: id,
        })
      ).toMatchObject({
        ok: false,
        reason: "not_found",
      });
    }
    expect(h.enqueued).toEqual([]);
  });

  it("provider only → every one of the CALLER's live connections for it, never another user's", async () => {
    h.rows.push({
      id: "row-mine-2",
      userId: "user-1",
      capabilityId: "cap-google",
      deletedAt: null,
    });
    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      provider: "google",
    });
    expect(r).toEqual({ ok: true, count: 2 });
    expect(h.enqueued.map((e) => e.connectionId)).toEqual([
      "row-mine",
      "row-mine-2",
    ]);
  });

  it("a multi-provider capability: the provider is the one the row's sync tool resolves under, not the first key", async () => {
    h.keysByCapability = { "cap-google": ["google", "notion"] };
    h.syncToolFor = { "row-mine": ["notion"] };
    h.rows = h.rows.filter((r) => r.id === "row-mine");
    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      connectionId: "row-mine",
    });
    expect(r).toEqual({ ok: true, count: 1 });
    expect(h.enqueued).toEqual([
      {
        provider: "notion",
        connectionId: "row-mine",
        workspaceId: null,
        reason: "manual",
      },
    ]);
  });

  it("a row with no sync tool for any of its providers is not_found — never enqueued as {enqueued:true}", async () => {
    h.syncToolFor = {};
    h.rows = h.rows.filter((r) => r.id === "row-mine");
    expect(
      await enqueueManualConnectionSync({
        userId: "user-1",
        connectionId: "row-mine",
      })
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(h.enqueued).toEqual([]);
  });

  it("provider only with no matching connection → not_found", async () => {
    const r = await enqueueManualConnectionSync({
      userId: "user-1",
      provider: "notion",
    });
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
    expect(h.enqueued).toEqual([]);
  });
});
