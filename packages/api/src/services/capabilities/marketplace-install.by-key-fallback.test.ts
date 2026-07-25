/**
 * marketplace-install — by-key re-resolve fallback (automation/template).
 *
 * Regression: `applyMarketInstall` used to REQUIRE a cp_catalog_cache row for
 * every non-capability kind, dead-ending automation/template installs in
 * NOT_FOUND on a cache miss (an opt-in / just-authored package the sync never
 * saw). This exercises the fix: with NO cache row, a template re-resolves its
 * definition by slug from the CP (mirroring the capability by-key fallback) and
 * installs, while `cell` still requires the row, and a pod with no CP configured
 * gets a clear NOT_FOUND.
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
vi.mock("./cells/define-cell.js", () => ({ defineCell: vi.fn() }));

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

  it("still requires a cache row for a cell (its renderer source is inline-only)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      applyMarketInstall({
        kind: "cell",
        slug: "some/cell",
        userId: "user-1",
        workspaceId: null,
      })
    ).rejects.toThrow(/no longer in the catalog cache/);
    // Cell never attempts a by-slug fetch — it dead-ends on the missing row.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
