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
  /** Proposal ids the governed template apply files instead of installing. */
  applyProposals: [] as string[],
  /** Pending `capability.create` proposals for the template's address. */
  pendingInstallRows: [] as Array<{ id: string }>,
}));

const { toolsTable, capabilitiesTable, proposalsTable } = vi.hoisted(() => ({
  toolsTable: { __table: "tools" },
  capabilitiesTable: { __table: "capabilities" },
  proposalsTable: { __table: "proposals" },
}));

vi.mock("@synap/database/schema", () => ({
  tools: toolsTable,
  capabilities: capabilitiesTable,
  proposals: proposalsTable,
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
            if (table === proposalsTable) return h.pendingInstallRows;
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
  drizzleSql: vi.fn(() => ({ op: "sql" })),
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
    return { created: { container: null }, proposals: h.applyProposals };
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
    listConnectionsResult: async () => ({
      ok: true as const,
      connections: providers.map((p) => ({
        provider: p.uniqueKey,
        connectionId: "conn-1",
      })),
    }),
    listIntegrationsResult: async () => ({
      ok: true as const,
      integrations: providers.map((p) => ({
        uniqueKey: p.uniqueKey,
        provider: p.uniqueKey,
        displayName: p.displayName,
      })),
    }),
  };
}

describe("materializeConnectorTools — a failed connection list is not 'nothing connected'", () => {
  it("throws instead of materializing zero tools when the broker cannot list", async () => {
    const connector: MaterializableConnector = {
      listConnectionsResult: async () => ({
        ok: false as const,
        reason: "unreachable",
        error: "control plane down",
      }),
      listIntegrationsResult: async () => ({
        ok: true as const,
        integrations: [],
      }),
    };
    await expect(materializeConnectorTools(ctx, connector)).rejects.toThrow(
      /listing connections failed \(unreachable\)/
    );
    expect(h.insertedTools).toHaveLength(0);
  });
});

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
  h.applyProposals = [];
  h.pendingInstallRows = [];
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

  it("a GOVERNED apply that files proposals is pendingInstall, never 'applied'", async () => {
    h.templateByKey["nango-google"] = {
      key: "nango-google",
      name: "Google",
      skills: [],
    };
    h.applyProposals = ["prop-tool", "prop-skill"];
    const result = await materializeConnectorTools(
      ctx,
      connectorFor([{ uniqueKey: "google", displayName: "Google" }])
    );
    expect(result.applied).toEqual([]);
    expect(result.pendingInstall).toEqual([
      { provider: "google", proposalIds: ["prop-tool", "prop-skill"] },
    ]);
  });

  it("a poll while the install is already pending runs NO governed apply and reports the pending proposals", async () => {
    h.templateByKey["nango-google"] = {
      key: "nango-google",
      name: "Google",
      skills: [],
    };
    h.pendingInstallRows = [{ id: "prop-container" }];
    const connector = connectorFor([
      { uniqueKey: "google", displayName: "Google" },
    ]);

    const first = await materializeConnectorTools(ctx, connector);
    const second = await materializeConnectorTools(ctx, connector);

    expect(h.createCapabilityFromDefinitionCalls).toHaveLength(0);
    for (const result of [first, second]) {
      expect(result.applied).toEqual([]);
      expect(result.pendingInstall).toEqual([
        { provider: "google", proposalIds: ["prop-container"] },
      ]);
    }
  });

  it("an apply that installs directly reports no pendingInstall (positive control)", async () => {
    h.templateByKey["nango-google"] = {
      key: "nango-google",
      name: "Google",
      skills: [],
    };
    const result = await materializeConnectorTools(
      ctx,
      connectorFor([{ uniqueKey: "google", displayName: "Google" }])
    );
    expect(result.pendingInstall).toEqual([]);
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

describe("pendingInstall reaches the client's connection rows", () => {
  it("annotatePendingInstall marks only the waiting provider's rows", async () => {
    const { annotatePendingInstall } = await import("./materialize-tools.js");
    const rows = annotatePendingInstall(
      [
        { provider: "google", connectionId: "g1" },
        { provider: "notion", connectionId: "n1" },
      ],
      [{ provider: "google", proposalIds: ["prop-1"] }]
    );
    expect(rows).toEqual([
      {
        provider: "google",
        connectionId: "g1",
        pendingInstall: { proposalIds: ["prop-1"] },
      },
      { provider: "notion", connectionId: "n1" },
    ]);
  });

  it("connectors.connections returns the rows annotated with the mirror's pendingInstall (source seam)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../routers/connectors-trpc.ts", import.meta.url)),
      "utf-8"
    );
    const start = src.indexOf("  connections: protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n    }),", start));
    expect(body).toMatch(
      /const pendingInstall = await mirrorObservedConnections\(/
    );
    expect(body).toMatch(
      /return annotatePendingInstall\(listed\.connections, pendingInstall\)/
    );
  });
});

describe("pendingInstall reaches the client's providers rows", () => {
  it("a pending provider is NOT connected and carries its proposal ids; others are untouched", async () => {
    const { annotateProviderPendingInstall } =
      await import("./materialize-tools.js");
    const rows = annotateProviderPendingInstall(
      [
        { id: "google", connected: true, connectionId: "g1" },
        { id: "notion", connected: true, connectionId: "n1" },
        { id: "slack", connected: false, connectionId: undefined },
      ],
      [{ provider: "google", proposalIds: ["prop-1"] }]
    );
    expect(rows).toEqual([
      {
        id: "google",
        connected: false,
        connectionId: "g1",
        pendingInstall: { proposalIds: ["prop-1"] },
      },
      {
        id: "notion",
        connected: true,
        connectionId: "n1",
        pendingInstall: null,
      },
      {
        id: "slack",
        connected: false,
        connectionId: undefined,
        pendingInstall: null,
      },
    ]);
  });

  it("connectors.providers returns rows annotated from the same mirror source (source seam)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../routers/connectors-trpc.ts", import.meta.url)),
      "utf-8"
    );
    const start = src.indexOf("  providers: protectedProcedure");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n    }),", start));
    expect(body).toMatch(
      /const pendingInstall = await mirrorObservedConnections\(/
    );
    expect(body).toMatch(/providers: annotateProviderPendingInstall\(/);
  });
});
