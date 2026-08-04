/**
 * materialize-tools.ts — bare provider tools must not be accidental orphans.
 *
 * `materializeConnectorTools` inserts a pod-wide provider `tools` row for every
 * connected provider, then (when the provider has a family `CapabilityDefinition`
 * in the CP catalog) applies it via `createCapabilityFromDefinition`, which puts
 * the tool in a named container. Providers WITHOUT a family template — the
 * common case for a provider added by convention before the CP has declared its
 * verbs — never took that path, so their tool was NEVER put in a container: an
 * accidental "loose brick" indistinguishable from a deliberate one.
 *
 * `ensureProviderContainer` closes that gap for the `!def` (bare) branch,
 * reusing the SAME container-resolution + GOVERNED-door convention
 * `create-from-definition.ts` uses (by name+scope, `containers.create` +
 * `containers.addPart`) — never a raw `links`/`capabilities` insert.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // `tools` table state
  existingToolRow: null as { id: string; capabilities: unknown } | null,
  insertedTools: [] as Array<Record<string, unknown>>,
  insertedToolReturns: [{ id: "tool-new-1" }] as Array<{ id: string }>,
  // `capabilities` (container) table state
  existingContainerRow: null as { id: string } | null,
  // containers router spies
  createCalls: [] as Array<Record<string, unknown>>,
  createResult: {
    capability: { id: "container-new-1" },
    status: "created",
  } as Record<string, unknown>,
  addPartCalls: [] as Array<Record<string, unknown>>,
  addPartShouldThrow: false,
  // CP template client
  templateByKey: {} as Record<string, unknown>,
  createCapabilityFromDefinitionCalls: [] as Array<unknown>,
}));

const { toolsTable, capabilitiesTable } = vi.hoisted(() => ({
  toolsTable: { __table: "tools" },
  capabilitiesTable: { __table: "capabilities" },
}));

vi.mock("@synap/database/schema", () => ({
  tools: toolsTable,
  capabilities: capabilitiesTable,
}));

vi.mock("@synap/database", () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === toolsTable) {
              return h.existingToolRow ? [h.existingToolRow] : [];
            }
            if (table === capabilitiesTable) {
              return h.existingContainerRow ? [h.existingContainerRow] : [];
            }
            return [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === toolsTable) h.insertedTools.push(v);
        return {
          onConflictDoNothing: () => ({
            returning: async () => h.insertedToolReturns,
          }),
        };
      },
    })),
  },
  eq: vi.fn((a, b) => ({ op: "eq", a, b })),
  and: vi.fn((...c) => ({ op: "and", c })),
  isNull: vi.fn((a) => ({ op: "isNull", a })),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.createCalls.push(input);
        return h.createResult;
      },
      addPart: async (input: Record<string, unknown>) => {
        h.addPartCalls.push(input);
        if (h.addPartShouldThrow) throw new Error("addPart boom");
        return { ok: true, status: "created" };
      },
    }),
  },
}));

vi.mock("../services/capabilities/cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: async (key: string) =>
    h.templateByKey[key] ?? null,
}));

vi.mock("../services/capabilities/create-from-definition.js", () => ({
  createCapabilityFromDefinition: async (...args: unknown[]) => {
    h.createCapabilityFromDefinitionCalls.push(args);
    return { created: { container: null } };
  },
}));

import { materializeConnectorTools } from "./materialize-tools.js";
import type { MaterializableConnector } from "./materialize-tools.js";
import type { Context } from "../types/context.js";

const ctx = { userId: "user-1", authenticated: true } as unknown as Context;

function connectorFor(
  providers: Array<{ uniqueKey: string; displayName: string }>
): MaterializableConnector {
  return {
    listConnections: async () =>
      providers.map((p) => ({ provider: p.uniqueKey, connectionId: "conn-1" })),
    listIntegrations: async () =>
      providers.map((p) => ({
        uniqueKey: p.uniqueKey,
        provider: p.uniqueKey,
        displayName: p.displayName,
      })),
  };
}

beforeEach(() => {
  h.existingToolRow = null;
  h.insertedTools.length = 0;
  h.insertedToolReturns = [{ id: "tool-new-1" }];
  h.existingContainerRow = null;
  h.createCalls.length = 0;
  h.createResult = {
    capability: { id: "container-new-1" },
    status: "created",
  };
  h.addPartCalls.length = 0;
  h.addPartShouldThrow = false;
  h.templateByKey = {};
  h.createCapabilityFromDefinitionCalls.length = 0;
});

describe("materializeConnectorTools — bare provider tool gets a container", () => {
  it("creates a container named after the provider and attaches the tool, when no family template exists", async () => {
    const connector = connectorFor([
      { uniqueKey: "notion", displayName: "Notion" },
    ]);

    const result = await materializeConnectorTools(ctx, connector);

    expect(result.toolIds).toEqual(["tool-new-1"]);
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({ name: "Notion" });
    expect(h.addPartCalls).toHaveLength(1);
    expect(h.addPartCalls[0]).toMatchObject({
      capabilityId: "container-new-1",
      partType: "tool",
      partId: "tool-new-1",
    });
  });

  it("reuses an existing container by name+scope instead of creating a duplicate", async () => {
    h.existingContainerRow = { id: "container-existing-1" };
    const connector = connectorFor([
      { uniqueKey: "notion", displayName: "Notion" },
    ]);

    await materializeConnectorTools(ctx, connector);

    expect(h.createCalls).toHaveLength(0);
    expect(h.addPartCalls).toHaveLength(1);
    expect(h.addPartCalls[0]).toMatchObject({
      capabilityId: "container-existing-1",
      partType: "tool",
      partId: "tool-new-1",
    });
  });

  it("is idempotent across two syncs of the same provider — no duplicate container, no duplicate attach call shape", async () => {
    const connector = connectorFor([
      { uniqueKey: "notion", displayName: "Notion" },
    ]);

    await materializeConnectorTools(ctx, connector);
    // Second sync: the tool now exists (found by credentialRef), and the
    // container now exists too (as the first run would have converged it).
    h.existingToolRow = { id: "tool-new-1", capabilities: [] };
    h.existingContainerRow = { id: "container-new-1" };

    await materializeConnectorTools(ctx, connector);

    // `create` ran once (first sync) and never again — the by-name+scope
    // lookup reused the container on the second sync instead of duplicating it.
    expect(h.createCalls).toHaveLength(1);
    // `addPart` is safe to call every sync (its own `onConflictDoNothing`
    // makes the SECOND call a no-op at the DB layer); we just assert it kept
    // targeting the SAME container + tool, not a new one.
    expect(h.addPartCalls[1]).toMatchObject({
      capabilityId: "container-new-1",
      partType: "tool",
      partId: "tool-new-1",
    });
  });

  it("does not run the bare-container path when a family template exists", async () => {
    h.templateByKey["nango-google"] = {
      key: "nango-google",
      name: "Google",
      skills: [],
    };
    const connector = connectorFor([
      { uniqueKey: "google", displayName: "Google" },
    ]);

    const result = await materializeConnectorTools(ctx, connector);

    expect(h.createCapabilityFromDefinitionCalls).toHaveLength(1);
    expect(h.createCalls).toHaveLength(0);
    expect(h.addPartCalls).toHaveLength(0);
    expect(result.applied).toEqual(["google"]);
  });

  it("is non-fatal when addPart fails — the sync still reports the tool as synced", async () => {
    h.addPartShouldThrow = true;
    const connector = connectorFor([
      { uniqueKey: "notion", displayName: "Notion" },
    ]);

    const result = await materializeConnectorTools(ctx, connector);

    expect(result.toolIds).toEqual(["tool-new-1"]);
    expect(h.addPartCalls).toHaveLength(1);
  });
});
