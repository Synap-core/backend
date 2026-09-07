/**
 * marketplace-install — by-key re-resolve fallback (automation/template/cell).
 *
 * Regression: `applyMarketInstall` used to REQUIRE a cp_catalog_cache row for
 * every non-capability kind, dead-ending automation/template/cell installs in
 * NOT_FOUND on a cache miss (an opt-in / just-authored package the sync never
 * saw). This exercises the fix: with NO cache row, a template re-resolves its
 * definition by slug from the CP (mirroring the capability by-key fallback), a
 * cell re-resolves by key from `GET /api/marketplace/cells?q=` (the same live
 * endpoint `routers/cells.ts` install already fetches from), and installs; a
 * cell genuinely absent from the CP, or a pod with no CP configured, still gets
 * a clear NOT_FOUND.
 *
 * The DB (`lookupCatalogEntry`) is mocked to return no row; the CP fetch is
 * mocked; the heavy downstream appliers are stubbed so the test isolates the
 * RESOLUTION decision (cache row vs by-key vs dead-end).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Downstream appliers + sibling modules stubbed so importing marketplace-install
// stays cheap and the test isolates the resolution path. `vi.hoisted` so the mock
// fn exists before the hoisted vi.mock factories run.
const { createWorkspaceMock } = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(async (_input: Record<string, unknown>) => ({
    workspaceId: "ws-installed",
    created: true,
  })),
}));
vi.mock("../workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: createWorkspaceMock,
}));
vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(),
}));
const { defineCellMock } = vi.hoisted(() => ({
  defineCellMock: vi.fn(async (_input: Record<string, unknown>) => ({
    typeKey: "cell:acme-charts:chart",
    changeType: "created" as const,
  })),
}));
vi.mock("../cells/define-cell.js", () => ({ defineCell: defineCellMock }));

// db.select().from().where().limit() → [] so lookupCatalogEntry finds no row.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [] as unknown[],
  };
  return {
    ...actual,
    db: { select: () => chain },
    getWorkspaceMembership: vi.fn(),
  };
});

import { applyMarketInstall } from "./marketplace-install.js";

const TEMPLATE_DEFINITION = {
  workspaceName: "Sales Pipeline",
  profiles: [],
};

describe("applyMarketInstall — by-key fallback", () => {
  const origFetch = global.fetch;
  const origCpUrl = process.env.CONTROL_PLANE_URL;

  beforeEach(() => {
    createWorkspaceMock.mockClear();
    defineCellMock.mockClear();
    process.env.CONTROL_PLANE_URL = "https://cp.example.test";
  });
  afterEach(() => {
    global.fetch = origFetch;
    if (origCpUrl === undefined) delete process.env.CONTROL_PLANE_URL;
    else process.env.CONTROL_PLANE_URL = origCpUrl;
  });

  it("re-resolves a template with NO cache row by slug from the CP, then installs", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({ package: { definition: TEMPLATE_DEFINITION } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyMarketInstall({
      kind: "template",
      slug: "sales-pipeline",
      userId: "user-1",
      workspaceId: null,
    });

    // The CP was hit by slug (the by-key re-resolve), not dead-ended.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe(
      "https://cp.example.test/api/packages/sales-pipeline"
    );

    // The fetched definition was handed to the workspace applier.
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(createWorkspaceMock.mock.calls[0][0]).toMatchObject({
      definition: TEMPLATE_DEFINITION,
      packageSlug: "sales-pipeline",
      templateName: "sales-pipeline",
    });

    expect(result).toMatchObject({
      kind: "template",
      workspaceId: "ws-installed",
      created: true,
    });
  });

  it("throws a clear NOT_FOUND for a template with no cache row when no CP is configured", async () => {
    delete process.env.CONTROL_PLANE_URL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      applyMarketInstall({
        kind: "template",
        slug: "sales-pipeline",
        userId: "user-1",
        workspaceId: null,
      })
    ).rejects.toThrow(/no Control Plane is configured to re-resolve it/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-resolves a cell with NO cache row by key from CP marketplace/cells, carrying the full field set", async () => {
    const CELL_ROW = {
      key: "chart",
      name: "Chart Cell",
      code: "export default () => null",
      deps: { react: "18.0.0" },
      viewTypes: ["kanban", "gallery"],
      externalHosts: ["api.example.com"],
      contentKind: "collection",
      packageSlug: "acme-charts",
      packageName: "Acme Charts",
      installCount: 3,
      isVerified: true,
    };
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify({ cells: [CELL_ROW] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await applyMarketInstall({
      kind: "cell",
      slug: "acme-charts/chart",
      userId: "user-1",
      workspaceId: null,
    });

    // Hit the live, uncached cell-discovery endpoint by key — not a dead-end.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe(
      "https://cp.example.test/api/marketplace/cells?q=chart"
    );

    // The full field set (contentKind/externalHosts/viewTypes included)
    // survived the fallback into the ONE write door (defineCell).
    expect(defineCellMock).toHaveBeenCalledTimes(1);
    expect(defineCellMock.mock.calls[0][0]).toMatchObject({
      typeKey: "cell:acme-charts:chart",
      viewTypes: ["kanban", "gallery"],
      externalHosts: ["api.example.com"],
      contentKind: "collection",
    });

    expect(result).toMatchObject({
      kind: "cell",
      typeKey: "cell:acme-charts:chart",
      packageSlug: "acme-charts",
    });
  });

  it("throws a clear NOT_FOUND for a cell genuinely absent from the CP (not a silent empty install)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ cells: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      applyMarketInstall({
        kind: "cell",
        slug: "acme-charts/nope",
        userId: "user-1",
        workspaceId: null,
      })
    ).rejects.toThrow(/not published on the marketplace/);
    expect(defineCellMock).not.toHaveBeenCalled();
  });

  it("throws a clear NOT_FOUND for a cell with no cache row when no CP is configured", async () => {
    delete process.env.CONTROL_PLANE_URL;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      applyMarketInstall({
        kind: "cell",
        slug: "acme-charts/chart",
        userId: "user-1",
        workspaceId: null,
      })
    ).rejects.toThrow(/no Control Plane is configured to re-resolve it/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
