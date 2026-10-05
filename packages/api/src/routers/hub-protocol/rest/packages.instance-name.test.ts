/**
 * Hub Protocol REST — POST /packages/apply NAMED INSTANCES (`instanceName`).
 *
 * The door must turn `instanceName` into the ONE idempotency key
 * (`workspaceInstanceKey`: `<slug>:<normalized name>`) and the workspace name
 * on BOTH paths that carry it — the governance gate's stored data (which the
 * `workspace/create` approve executor replays) and the granted materialize —
 * and keep the singleton key (`<slug>`) when no name is given. The key's
 * create/reuse semantics are proven against a real DB in
 * `services/workspace-named-instance.pglite.test.ts`; this file covers the
 * door's wiring, with the same isolated-Hono harness as
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

describe("POST /packages/apply — named instances", () => {
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

  it("no instanceName → singleton key = slug, template's own name (unchanged default)", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(201);
    expect(mockCheckPermission.mock.calls[0][0].data).toMatchObject({
      proposalId: "brand-library",
      workspaceName: "Brand Library",
    });
    expect(mockMaterialize.mock.calls[0][0]).toMatchObject({
      proposalId: "brand-library",
      workspaceName: "Brand Library",
    });
  });

  it("instanceName → <slug>:<normalized> key + the instance's name, on the GATE data the approve executor replays", async () => {
    mockCheckPermission.mockResolvedValue({ proposalId: "prop-1" });
    const res = await apply(buildApp(), {
      ...PKG,
      instanceName: "Architech Brand",
    });
    expect(res.status).toBeLessThan(300);
    expect(mockCheckPermission.mock.calls[0][0].data).toMatchObject({
      name: "Architech Brand",
      workspaceName: "Architech Brand",
      proposalId: "brand-library:architech-brand",
      packageSlug: "brand-library",
    });
    // Proposed → nothing materialized yet.
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("instanceName → the same key + name on the GRANTED materialize", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    await apply(buildApp(), { ...PKG, instanceName: "Architech Brand" });
    expect(mockMaterialize.mock.calls[0][0]).toMatchObject({
      proposalId: "brand-library:architech-brand",
      workspaceName: "Architech Brand",
      packageSlug: "brand-library",
    });
  });

  it("instanceName + targetWorkspaceId → 400, before governance", async () => {
    const res = await apply(buildApp(), {
      ...PKG,
      instanceName: "Architech Brand",
      targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
    });
    expect(res.status).toBe(400);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("an instanceName with no letters or digits → 400, never the singleton", async () => {
    const res = await apply(buildApp(), { ...PKG, instanceName: "!!!" });
    expect(res.status).toBe(400);
    expect(mockCheckPermission).not.toHaveBeenCalled();
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

  it("asks the verdict with the instance key, the agent and the name", async () => {
    mockVerdict.mockResolvedValue({ action: "create" });
    mockCheckPermission.mockResolvedValue({ proposalId: "p" });
    await apply(buildApp("agent-1"), { ...PKG, instanceName: "Architech" });
    expect(mockVerdict.mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      agentUserId: "agent-1",
      packageSlug: "brand-library",
      idempotencyKey: "brand-library:architech",
      workspaceName: "Architech",
    });
  });

  it("refused → 409 with the typed `exists` body, BEFORE governance (no proposal filed)", async () => {
    const reply = {
      status: "exists",
      workspaceId: "ws-brand",
      workspaceName: "Brand Library",
      matchedBy: "template",
      guidance: "g",
    };
    mockVerdict.mockResolvedValue({ action: "refuse", reply });
    const res = await apply(buildApp("agent-1"), {
      ...PKG,
      instanceName: "Architech",
    });
    expect(res.status).toBe(409);
    // `error` carries the guidance: Hub clients surface a 4xx through it.
    expect(await res.json()).toEqual({ ...reply, error: reply.guidance });
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("a human's note rides on the created reply", async () => {
    const note = { existingWorkspaceId: "ws-brand", guidance: "g" };
    mockVerdict.mockResolvedValue({ action: "create", note });
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    const res = await apply(buildApp(), { ...PKG, instanceName: "Architech" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.oneSpacePerDomain).toEqual(note);
    expect(body.workspace).toMatchObject({ outcome: "created" });
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
