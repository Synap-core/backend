/**
 * Contract test — GET /api/hub/connectors/sync-status.
 *
 * Pins the seam to `getConnectionSyncStatus` (services/event-sync/connection-sync.ts):
 * scope-gated, forwards `provider`/`workspaceId` from the query string, and — the
 * defect class this repo keeps re-finding — a read FAILURE must surface as an error,
 * never fold into `{ statuses: [] }` (which would render as "nothing is syncing").
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const calls: any[] = [];
let behavior: "ok" | "throw" = "ok";

const FIXTURE_STATUS = {
  provider: "google",
  connectionId: "conn-1",
  workspaceId: "ws-1",
  kind: "event",
  enabled: true,
  profileSlugs: ["event"],
  openableProfileSlugs: ["event"],
  phase: "synced" as const,
  counts: { fetched: 3, created: 1, merged: 2, skipped: 0 },
  keepSyncing: { enabled: true, ruleId: "rule-1", available: true },
};

// importOriginal + spread: the route imports BOTH `getConnectionSyncStatus`
// (mocked below) and the real `ConnectionSyncStatusSchema` (the response
// schema is now derived from it, P2 fix) — a full replacement mock would
// leave the schema `undefined` and crash route registration, not the test.
vi.mock(
  "../../../services/event-sync/connection-sync.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/event-sync/connection-sync.js")
      >();
    return {
      ...actual,
      getConnectionSyncStatus: async (input: any) => {
        calls.push(input);
        if (behavior === "throw") throw new Error("db unavailable");
        return [FIXTURE_STATUS];
      },
    };
  }
);

// Sibling imports this route file pulls in, unrelated to this door.
vi.mock("../../../connectors/index.js", () => ({
  resolveBroker: async () => ({
    ok: false,
    reason: "not-configured",
    error: "",
  }),
  BrokerRefusalError: class BrokerRefusalError extends Error {},
}));
vi.mock("../../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: async () => ({
    success: true,
    status: 200,
    headers: {},
    body: {},
  }),
}));
vi.mock("../../../connectors/materialize-tools.js", () => ({
  materializeConnectorTools: async () => ({}),
}));
vi.mock(
  "../../../services/capabilities/capability-nango-sync.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    disconnectOwnedConnection: async () => ({ ok: true }),
  })
);

const { registerConnectorsRoutes } = await import("./connectors.js");
// The REAL schema (the mock above importOriginal+spreads it) — used below to
// prove the schema itself, not just the route, accepts the newer fields.
const { ConnectionSyncStatusSchema } =
  await import("../../../services/event-sync/connection-sync.js");

function buildApp(scopes: string[] = ["hub-protocol.read"]) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, scopes as never);
    c.set("userId" as never, "user-1" as never);
    await next();
  });
  registerConnectorsRoutes(app as never);
  return app;
}

async function get(qs = "") {
  return buildApp().request(`/connectors/sync-status${qs}`);
}

describe("GET /connectors/sync-status", () => {
  beforeEach(() => {
    calls.length = 0;
    behavior = "ok";
  });

  it("requires hub-protocol.read", async () => {
    const app = buildApp([]);
    const res = await app.request("/connectors/sync-status");
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("returns the status rows from getConnectionSyncStatus", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      statuses: Array<{ workspaceId?: string | null }>;
    };
    expect(body.statuses).toEqual([FIXTURE_STATUS]);
    // The response schema is DERIVED from `ConnectionSyncStatusSchema`
    // (connection-sync.ts), not hand-copied — this is the field that a
    // hand-copy previously dropped (P2). Asserted explicitly so a future
    // re-introduction of a hand-copied schema fails here, not silently.
    expect(body.statuses[0].workspaceId).toBe("ws-1");
  });

  it("forwards provider and workspaceId from the query string", async () => {
    await get("?provider=google&workspaceId=ws-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "google", workspaceId: "ws-1" });
  });

  it("omits workspaceId (undefined, not null) when the query does not carry one", async () => {
    await get("?provider=google");
    expect(calls[0].workspaceId).toBeUndefined();
  });

  // NEGATIVE CONTROL target: a read failure must surface as a 500 error, never
  // silently become `{ statuses: [] }` — the EMPTY-vs-FAILED defect class this
  // codebase keeps re-introducing (see .claude/rules — "never catch { return [] }").
  it("surfaces a read failure as a 500 error, not an empty status list", async () => {
    behavior = "throw";
    const res = await get();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; statuses?: unknown };
    expect(body.error).toMatch(/db unavailable/);
    expect(body.statuses).toBeUndefined();
  });
});

// Schema-level coverage for `counts.byProfile`, `keepSyncing` (now REQUIRED,
// B1's producer populates it on every row), and the `"not_connected"` phase
// (now a plain `SyncPhase` value, B1 landed it in sync-kind-registry.ts too) —
// proves the SCHEMA (the single source the route derives from) accepts and
// preserves them.
describe("ConnectionSyncStatusSchema — counts.byProfile, keepSyncing, not_connected", () => {
  const BASE = {
    provider: "google",
    workspaceId: null,
    kind: "event",
    enabled: true,
    profileSlugs: ["event"],
    openableProfileSlugs: ["event"],
    keepSyncing: { enabled: false, available: false },
  };

  it("accepts the 'not_connected' phase", () => {
    const result = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      phase: "not_connected",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects an unknown phase (the enum is closed, not a free string)", () => {
    const result = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      phase: "bogus_phase",
    });
    expect(result.success).toBe(false);
  });

  it("accepts AND PRESERVES counts.byProfile as a per-profile created/merged map", () => {
    // Zod strips unrecognized keys by default rather than rejecting them, so a
    // bare `.success === true` would pass just as well against a schema that
    // never declared `byProfile` at all — asserting on the PARSED output is
    // what actually proves the field is declared, not merely tolerated.
    const byProfile = {
      event: { created: 1, merged: 0 },
      person: { created: 0, merged: 2 },
    };
    const result = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      counts: { fetched: 3, created: 1, merged: 2, skipped: 0, byProfile },
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.counts?.byProfile).toEqual(byProfile);
  });

  it("REQUIRES keepSyncing (missing, not just wrong, is rejected)", () => {
    const { keepSyncing: _drop, ...withoutKeepSyncing } = BASE;
    const result = ConnectionSyncStatusSchema.safeParse(withoutKeepSyncing);
    expect(result.success).toBe(false);
  });

  it("accepts AND PRESERVES keepSyncing as {enabled, available, ruleId?}", () => {
    const withRule = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      keepSyncing: { enabled: true, ruleId: "rule-1", available: true },
    });
    expect(withRule.success).toBe(true);
    if (withRule.success) {
      expect(withRule.data.keepSyncing).toEqual({
        enabled: true,
        ruleId: "rule-1",
        available: true,
      });
    }

    const withoutRule = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      keepSyncing: { enabled: false, available: false },
    });
    expect(withoutRule.success).toBe(true);
    if (withoutRule.success) {
      expect(withoutRule.data.keepSyncing).toEqual({
        enabled: false,
        available: false,
      });
    }
  });

  it("rejects keepSyncing missing 'available' (it is required, not optional)", () => {
    const result = ConnectionSyncStatusSchema.safeParse({
      ...BASE,
      keepSyncing: { enabled: true },
    });
    expect(result.success).toBe(false);
  });

  it("still requires workspaceId (the P2 field) — null is valid, missing is not", () => {
    const { workspaceId: _drop, ...withoutWorkspaceId } = BASE;
    const result = ConnectionSyncStatusSchema.safeParse(withoutWorkspaceId);
    expect(result.success).toBe(false);
  });
});
