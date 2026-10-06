/**
 * Hub Protocol REST — POST /packages/apply TEMPLATE IDENTITY (0308).
 *
 * A template is installed ONCE per pod, keyed by its slug (founder
 * 2026-10-06). The door must:
 *   - refuse a body with no `_meta.slug` and no `targetWorkspaceId` (400,
 *     before governance) — the incident: a slug-less `market update` became a
 *     proposal keyed on its own row id and minted a second, empty space;
 *   - refuse the retired `instanceName` (400) instead of silently dropping it;
 *   - key both the governance data (replayed by the approve executor) and the
 *     granted materialize on the slug.
 * Create/reuse semantics against real indexes: `services/workspace-template-
 * once.pglite.test.ts`. Same isolated-Hono harness as
 * `packages.preflight-gate.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPreflight,
  mockCheckPermission,
  mockMaterialize,
  mockApplyPost,
  mockComposeTarget,
  mockVerdict,
} = vi.hoisted(() => ({
  mockVerdict: vi.fn(),
  mockPreflight: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockMaterialize: vi.fn(),
  mockApplyPost: vi.fn(),
  mockComposeTarget: vi.fn(),
}));

vi.mock("../../../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: (...a: unknown[]) => mockComposeTarget(...a),
}));

// Partial mock: the route's import graph reaches modules that read real
// `@synap/database` enums at load time (e.g. `ProposalStatus` in
// forms/guest-retention.ts) — a bare factory mock failed the whole suite at
// import, before any assertion ran.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  preflightWorkspaceFromDefinition: (...a: unknown[]) => mockPreflight(...a),
}));

vi.mock("../../../services/workspace-materialization-service.js", () => ({
  materializeWorkspaceCore: (...a: unknown[]) => mockMaterialize(...a),
  ComposeBaseUnavailableError: class extends Error {},
  DependencyResolutionError: class extends Error {},
  ComposeBaseNotFoundError: class extends Error {},
  ComposeOverlayError: class extends Error {},
}));

vi.mock("../../../services/package-apply-post-workspace.js", () => ({
  applyPackagePostWorkspace: (...a: unknown[]) => mockApplyPost(...a),
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) => mockCheckPermission(...a),
}));

vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

// The verdict itself is proven on PGlite (`one-space-per-domain.pglite.test.ts`);
// here only the door's wiring of it.
vi.mock(
  "../../../services/workspace-creation-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/workspace-creation-service.js")
    >()),
    checkOneSpacePerDomain: (...a: unknown[]) => mockVerdict(...a),
  })
);

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerPackagesRoutes } from "./packages.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(agentUserId?: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    if (agentUserId) c.set("agentUserId", agentUserId);
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerPackagesRoutes(app);
  return app;
}

function apply(app: HubHono, body: Record<string, unknown>) {
  return app.request("/packages/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const okReport = {
  dryRun: true,
  ok: true,
  validationErrors: [],
  profiles: {
    create: [],
    reused: [],
    conflicts: [],
    deferred: [],
    scopeConflicts: [],
  },
  entityLinks: { unresolved: [] },
  views: { wouldOrphan: [] },
};

const PKG = {
  _meta: { slug: "brand-library" },
  workspaceName: "Brand Library",
  profiles: [{ slug: "brand_color", displayName: "Color" }],
};

describe("POST /packages/apply — template identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreflight.mockResolvedValue(okReport);
    mockVerdict.mockResolvedValue({ action: "create" });
    mockApplyPost.mockResolvedValue({});
    mockMaterialize.mockResolvedValue({
      status: "created",
      workspaceId: "ws-1",
      created: { workspaceId: "ws-1", created: true, outcome: "created" },
    });
  });

  it("keys the GATE data (replayed on approve) and the granted materialize on the slug", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(201);
    expect(mockCheckPermission.mock.calls[0][0].data).toMatchObject({
      proposalId: "brand-library",
      packageSlug: "brand-library",
      workspaceName: "Brand Library",
    });
    expect(mockMaterialize.mock.calls[0][0]).toMatchObject({
      proposalId: "brand-library",
      packageSlug: "brand-library",
      workspaceName: "Brand Library",
    });
  });

  it("no `_meta.slug` and no target → 400, before governance (the incident)", async () => {
    const { _meta: _drop, ...noSlug } = PKG;
    void _drop;
    for (const body of [noSlug, { ...noSlug, _meta: { version: "h-1" } }]) {
      const res = await apply(buildApp(), body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "_meta.slug"
      );
    }
    expect(mockVerdict).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("no slug but a targetWorkspaceId is fine — it installs onto that space", async () => {
    mockCheckPermission.mockResolvedValue({ proposalId: "p" });
    const { _meta: _drop, ...noSlug } = PKG;
    void _drop;
    const res = await apply(buildApp(), {
      ...noSlug,
      targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
    });
    expect(res.status).toBeLessThan(300);
    expect(mockCheckPermission).toHaveBeenCalled();
  });

  it("instanceName is retired → 400, never a second copy", async () => {
    const res = await apply(buildApp(), {
      ...PKG,
      instanceName: "Architech Brand",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "retired"
    );
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
});

describe("POST /packages/apply — one space per domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreflight.mockResolvedValue(okReport);
    mockApplyPost.mockResolvedValue({});
    mockMaterialize.mockResolvedValue({
      status: "created",
      workspaceId: "ws-2",
      created: { workspaceId: "ws-2", created: true, outcome: "created" },
    });
  });

  it("asks the verdict with the slug key and the name — no caller kind", async () => {
    mockVerdict.mockResolvedValue({ action: "create" });
    mockCheckPermission.mockResolvedValue({ proposalId: "p" });
    await apply(buildApp("agent-1"), PKG);
    expect(mockVerdict.mock.calls[0][0]).toEqual({
      userId: "user-1",
      packageSlug: "brand-library",
      idempotencyKey: "brand-library",
      workspaceName: "Brand Library",
    });
  });

  it("refused → 409 with the typed `exists` body, BEFORE governance — for a HUMAN too", async () => {
    const reply = {
      status: "exists",
      workspaceId: "ws-brand",
      workspaceName: "Brand Library",
      matchedBy: "template",
      guidance: "g",
    };
    mockVerdict.mockResolvedValue({ action: "refuse", reply });
    for (const app of [buildApp("agent-1"), buildApp()]) {
      const res = await apply(app, PKG);
      expect(res.status).toBe(409);
      // `error` carries the guidance: Hub clients surface a 4xx through it.
      expect(await res.json()).toEqual({ ...reply, error: reply.guidance });
    }
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("targetWorkspaceId installs onto an existing space — no verdict asked", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    mockMaterialize.mockResolvedValue({
      status: "composed",
      workspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
      composeTargetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
      dependencies: [],
      reconcile: {
        profiles: { added: [] },
        properties: { added: [], conflicts: [] },
        views: { added: [] },
        entityLinks: { added: [] },
      },
    });
    await apply(buildApp("agent-1"), {
      ...PKG,
      targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
    });
    expect(mockVerdict).not.toHaveBeenCalled();
  });
});
