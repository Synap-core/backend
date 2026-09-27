/**
 * D8 at the TOP-LEVEL install door (`materializeWorkspaceCore` — Hub
 * `/packages/apply`, tRPC `createFromDefinition`, the approve executor, and now
 * `market.install`): a pack is layered onto its primary domain, never created
 * as a stray "suite" workspace. A legacy suite workspace already on the pod
 * keeps working (falls through to the idempotent create, which reuses it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  resolveDepsMock,
  composeMock,
  createMock,
  legacyRows,
  legacyWhere,
  resolveTplMock,
} = vi.hoisted(() => ({
  resolveDepsMock: vi.fn(),
  composeMock: vi.fn(async () => ({ profiles: { added: [] } })),
  createMock: vi.fn(async () => ({
    workspaceId: "ws-legacy",
    created: false,
    outcome: "unchanged",
  })),
  legacyRows: { current: [] as Array<{ id: string }> },
  legacyWhere: { current: undefined as unknown },
  resolveTplMock: vi.fn(async () => null),
}));

vi.mock("./package-dependency-resolver.js", () => ({
  resolvePackageDependencies: resolveDepsMock,
}));
vi.mock("./compose-overlay.js", () => ({
  composeOntoBaseWorkspace: composeMock,
  ComposeBaseNotFoundError: class extends Error {},
  ComposeOverlayError: class extends Error {},
}));
vi.mock("./workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: createMock,
}));
vi.mock("./capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: resolveTplMock,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => {
      legacyWhere.current = w;
      return chain;
    },
    limit: async () => legacyRows.current,
  };
  return { ...actual, db: { select: () => chain } };
});

import { materializeWorkspaceCore } from "./workspace-materialization-service.js";

const PACK = {
  _meta: { slug: "enterprise-os", tags: ["suite"] },
  dependencies: [
    { slug: "foundation", kind: "workspace", relation: "require" },
    { slug: "crm", kind: "workspace", relation: "require" },
  ],
  profiles: [{ slug: "objective" }],
} as never;

describe("materializeWorkspaceCore — D8 packs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    legacyRows.current = [];
    resolveDepsMock.mockResolvedValue({
      composeRequested: false,
      installed: [
        { slug: "foundation", workspaceId: "ws-foundation", action: "found" },
        { slug: "crm", workspaceId: "ws-crm", action: "installed" },
      ],
    });
  });

  it("layers a pack onto its FIRST required domain — no workspace created", async () => {
    const core = await materializeWorkspaceCore({
      definition: PACK,
      userId: "u",
      selfSlug: "enterprise-os",
      packageSlug: "enterprise-os",
      packageVersion: "h-1",
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(core).toMatchObject({
      status: "composed",
      workspaceId: "ws-foundation",
    });
    expect(composeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        composeTargetWorkspaceId: "ws-foundation",
        overlay: { slug: "enterprise-os", version: "h-1" },
      })
    );
  });

  it("the tRPC door (no _meta on the definition) is detected by slug", async () => {
    resolveTplMock.mockResolvedValueOnce({
      packageDefinition: { _meta: { tags: ["suite"] } },
    } as never);
    const { _meta: _m, ...noMeta } = PACK as unknown as Record<string, unknown>;
    const core = await materializeWorkspaceCore({
      definition: noMeta as never,
      userId: "u",
      selfSlug: "enterprise-os",
      packageSlug: "enterprise-os",
      deferCreate: true,
    });
    expect(core.status).toBe("composed");
  });

  it("a LEGACY suite workspace is reused, not duplicated onto the domain", async () => {
    legacyRows.current = [{ id: "ws-legacy" }];
    const core = await materializeWorkspaceCore({
      definition: PACK,
      userId: "u",
      selfSlug: "enterprise-os",
      packageSlug: "enterprise-os",
    });
    expect(composeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(core.status).toBe("created");
  });

  it("the legacy lookup ALSO matches a pre-0278 row stamped only in settings.packageSlug (RV1 S8)", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    await materializeWorkspaceCore({
      definition: PACK,
      userId: "u",
      selfSlug: "enterprise-os",
      packageSlug: "enterprise-os",
    });
    const q = new PgDialect().sqlToQuery(legacyWhere.current as never);
    expect(q.sql).toContain(`"package_slug" = $`);
    expect(q.sql).toContain(`->>'packageSlug' = $`);
    // Both stamps are compared to the pack's slug.
    expect(q.params.filter((p) => p === "enterprise-os")).toHaveLength(2);
  });

  it("a non-pack template is created exactly as before", async () => {
    resolveDepsMock.mockResolvedValue({
      composeRequested: false,
      installed: [],
    });
    await materializeWorkspaceCore({
      definition: { _meta: { slug: "crm", tags: ["crm"] } } as never,
      userId: "u",
      selfSlug: "crm",
      packageSlug: "crm",
    });
    expect(composeMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
