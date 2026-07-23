/**
 * resolveWorkspaceTemplate — cache-first resolution + frozen-bundle fallback.
 *
 * This is the door the BOOT reconcile hook
 * (`apps/api/src/startup/reconcile-workspaces-to-templates.ts`) now delegates to
 * (replacing the direct `getWorkspaceTemplate` bundle read), so these cases lock
 * the two contracts that hook relies on:
 *   (a) a `cp_catalog_cache` HIT resolves from the FRESH CP definition, and
 *   (b) a cache MISS falls back to the frozen `@synap-core/workspace-templates`
 *       bundle — byte-identical to the old direct read (offline boot safety).
 *
 * Heavy I/O (`db`, the templates bundle) is mocked — mirrors the mocking style
 * in `package-dependency-resolver.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cacheRows,
  mockGetWorkspaceTemplate,
  mockToPackageDefinition,
  mockToWorkspaceDefinition,
} = vi.hoisted(() => ({
  cacheRows: [] as unknown[],
  mockGetWorkspaceTemplate: vi.fn(),
  mockToPackageDefinition: vi.fn(),
  mockToWorkspaceDefinition: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => cacheRows,
        }),
      }),
    }),
  },
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

vi.mock("@synap/database/schema", () => ({
  cpCatalogCache: {
    kind: "kind",
    slug: "slug",
    source: "source",
    version: "version",
    definition: "definition",
  },
}));

vi.mock("@synap-core/workspace-templates", () => ({
  getWorkspaceTemplate: (...a: unknown[]) => mockGetWorkspaceTemplate(...a),
  toWorkspaceDefinition: (...a: unknown[]) => mockToWorkspaceDefinition(...a),
  toPackageDefinition: (...a: unknown[]) => mockToPackageDefinition(...a),
}));

import { resolveWorkspaceTemplate } from "./resolve-workspace-template.js";

describe("resolveWorkspaceTemplate — cache-first + bundle fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheRows.length = 0;
  });

  it("resolves from the CP catalog cache when a row exists (source=cache)", async () => {
    // A cache HIT with the full definition inline (workspace-shape fields).
    cacheRows.push({
      source: "https://cp.example",
      version: "v-cache-123",
      definition: {
        workspaceName: "Grants (fresh from CP)",
        profiles: [{ slug: "grant", displayName: "Grant" }],
        dependencies: [{ slug: "foundation", relation: "require" }],
        bentoLayout: [
          { widgetType: "stat-card", pos: { x: 0, y: 0, w: 3, h: 3 } },
        ],
      },
    });

    const resolved = await resolveWorkspaceTemplate("grants");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("cache");
    expect(resolved!.version).toBe("v-cache-123");
    expect(resolved!.dependencies).toEqual([
      { slug: "foundation", relation: "require" },
    ]);
    // Mapped to a workspace-shape definition WITHOUT touching the frozen bundle.
    expect(resolved!.workspaceDefinition.workspaceName).toBe(
      "Grants (fresh from CP)"
    );
    expect(resolved!.workspaceDefinition.bentoLayout).toHaveLength(1);
    expect(mockGetWorkspaceTemplate).not.toHaveBeenCalled();
  });

  it("falls back to the frozen bundle on a cache MISS (source=bundle)", async () => {
    // No cache row → the resolver reads the bundle exactly as before.
    mockGetWorkspaceTemplate.mockReturnValue({
      meta: { slug: "grants" },
      dependencies: [{ slug: "foundation" }],
    });
    mockToPackageDefinition.mockReturnValue({
      workspaceName: "Grants (bundle)",
      profiles: [],
      dependencies: [{ slug: "foundation" }],
    });
    mockToWorkspaceDefinition.mockReturnValue({
      definition: { workspaceName: "Grants (bundle)", profiles: [] },
    });

    const resolved = await resolveWorkspaceTemplate("grants");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("bundle");
    expect(resolved!.workspaceDefinition.workspaceName).toBe("Grants (bundle)");
    expect(mockGetWorkspaceTemplate).toHaveBeenCalledWith("grants");
  });

  it("returns null when neither cache nor bundle knows the slug", async () => {
    mockGetWorkspaceTemplate.mockReturnValue(undefined);
    const resolved = await resolveWorkspaceTemplate("does-not-exist");
    expect(resolved).toBeNull();
  });
});
