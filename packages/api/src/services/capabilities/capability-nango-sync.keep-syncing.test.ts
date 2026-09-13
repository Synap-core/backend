import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setConnectionKeepSyncing` — the door behind `connectors.setKeepSyncing`.
 *
 * Properties pinned:
 *  - only the connection's OWNER can toggle it (checked in code: the db mock
 *    returns the row it is asked for, owned by whoever the fixture says);
 *  - the rule is scoped to the workspace of the provider tool the sync door
 *    resolves for this connection;
 *  - on = `ensureConnectionAutoRule` with the approved first import as lineage;
 *    off = `disableConnectionAutoRule`; no import approved yet = refused.
 * No rule is written by hand: both rule writes go through the database helpers.
 */

const h = vi.hoisted(() => ({
  row: null as null | {
    id: string;
    userId: string;
    capabilityId: string | null;
    deletedAt: Date | null;
  },
  approved: [] as Array<{ id: string }>,
  toolWorkspaceId: "ws-9" as string | null,
  ensured: [] as Array<Record<string, unknown>>,
  disabled: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const rowsFor = (table: unknown) =>
    table === schema.secrets
      ? h.row
        ? [h.row]
        : []
      : table === schema.proposals
        ? h.approved
        : [];
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => rowsFor(table),
            orderBy: () => ({ limit: async () => rowsFor(table) }),
          }),
        }),
      }),
    },
    ensureConnectionAutoRule: vi.fn(async (input: Record<string, unknown>) => {
      h.ensured.push(input);
      return { ruleId: "rule-1", created: true };
    }),
    ensureConnectionReviewRule: vi.fn(
      async (input: Record<string, unknown>) => {
        h.disabled.push(input);
        return { ruleId: "rule-review", created: true };
      }
    ),
  };
});

vi.mock("./capability-provider-resolution.js", () => ({
  resolveCapabilityNangoProviderKeys: vi.fn(async () => ["google"]),
}));

vi.mock("../event-sync/sync-state-store.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSyncTool: vi.fn(async () => ({
    id: "tool-1",
    createdBy: "user-1",
    workspaceId: h.toolWorkspaceId,
    metadata: {},
  })),
  // The ONE "approved first import for this connection" predicate (its SQL is
  // pinned by its own pglite test); the toggle's lineage is whatever it returns.
  findApprovedConnectionImport: vi.fn(async () => h.approved[0] ?? null),
}));

vi.mock("../event-sync/connection-sync.js", () => ({
  enqueueConnectionSync: vi.fn(async () => undefined),
}));

import { setConnectionKeepSyncing } from "./capability-nango-sync.js";

beforeEach(() => {
  h.row = {
    id: "row-mine",
    userId: "user-1",
    capabilityId: "cap-google",
    deletedAt: null,
  };
  h.approved = [{ id: "prop-1" }];
  h.toolWorkspaceId = "ws-9";
  h.ensured = [];
  h.disabled = [];
});

describe("setConnectionKeepSyncing", () => {
  it("the owner turns it ON: an auto rule in the sync tool's scope, lineage = the approved import", async () => {
    const r = await setConnectionKeepSyncing({
      userId: "user-1",
      connectionId: "row-mine",
      enabled: true,
    });
    expect(r).toEqual({ ok: true, enabled: true, ruleId: "rule-1" });
    expect(h.ensured).toEqual([
      {
        db: expect.anything(),
        userId: "user-1",
        workspaceId: "ws-9",
        connectionId: "row-mine",
        sourceProposalId: "prop-1",
      },
    ]);
    expect(h.disabled).toEqual([]);
  });

  it("the owner turns it OFF: the rule in that same scope is revoked", async () => {
    h.toolWorkspaceId = null;
    const r = await setConnectionKeepSyncing({
      userId: "user-1",
      connectionId: "row-mine",
      enabled: false,
    });
    expect(r).toEqual({ ok: true, enabled: false });
    expect(h.disabled).toEqual([
      {
        db: expect.anything(),
        userId: "user-1",
        workspaceId: null,
        connectionId: "row-mine",
        sourceProposalId: "prop-1",
      },
    ]);
    expect(h.ensured).toEqual([]);
  });

  it("turning it off before any import was approved is refused — no rule without lineage", async () => {
    h.approved = [];
    expect(
      await setConnectionKeepSyncing({
        userId: "user-1",
        connectionId: "row-mine",
        enabled: false,
      })
    ).toMatchObject({ ok: false, reason: "no_approved_import" });
    expect(h.disabled).toEqual([]);
  });

  it("ANOTHER user's connection is not_found — neither on nor off touches a rule", async () => {
    h.row = {
      id: "row-theirs",
      userId: "user-2",
      capabilityId: "cap-google",
      deletedAt: null,
    };
    for (const enabled of [true, false]) {
      expect(
        await setConnectionKeepSyncing({
          userId: "user-1",
          connectionId: "row-theirs",
          enabled,
        })
      ).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(h.ensured).toEqual([]);
    expect(h.disabled).toEqual([]);
  });

  it("a deleted row is not_found", async () => {
    h.row = {
      id: "row-mine",
      userId: "user-1",
      capabilityId: "cap-google",
      deletedAt: new Date(),
    };
    expect(
      await setConnectionKeepSyncing({
        userId: "user-1",
        connectionId: "row-mine",
        enabled: true,
      })
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(h.ensured).toEqual([]);
  });

  it("turning it on before any import was approved is refused — no rule without lineage", async () => {
    h.approved = [];
    expect(
      await setConnectionKeepSyncing({
        userId: "user-1",
        connectionId: "row-mine",
        enabled: true,
      })
    ).toMatchObject({ ok: false, reason: "no_approved_import" });
    expect(h.ensured).toEqual([]);
  });
});
