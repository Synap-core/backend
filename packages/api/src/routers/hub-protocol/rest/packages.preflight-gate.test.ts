/**
 * Hub Protocol REST — POST /packages/apply LIVE preflight gate.
 *
 * The apply handler runs the write-free `preflightWorkspaceFromDefinition`
 * BEFORE governance/materialize and returns 422 when it is not `ok` — a
 * profileKind conflict or duplicate/invalid slug is a pod-integrity invariant.
 * `force:true` may bypass ADVISORY findings (the wave-2 pure validator) but MUST
 * NOT bypass a LIVE structural failure, and the gate must stop BEFORE the
 * permission check / materialize ever run.
 *
 * Strategy: isolated Hono app mounting only `registerPackagesRoutes`, with
 * `@synap/database` (preflight) + the materialization/post-workspace services +
 * permission-check mocked — mirrors the `links.test.ts` harness.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPreflight, mockCheckPermission, mockMaterialize, mockApplyPost } =
  vi.hoisted(() => ({
    mockPreflight: vi.fn(),
    mockCheckPermission: vi.fn(),
    mockMaterialize: vi.fn(),
    mockApplyPost: vi.fn(),
  }));

vi.mock("@synap/database", () => ({
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

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerPackagesRoutes } from "./packages.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
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

/** A structural-failure preflight (profileKind conflict) — `ok:false`. */
const conflictReport = {
  dryRun: true,
  ok: false,
  validationErrors: [],
  profiles: {
    create: [],
    reused: [],
    conflicts: [{ slug: "client", existingKind: "kind", declaredKind: "role" }],
    deferred: [],
    scopeConflicts: [],
  },
  entityLinks: { unresolved: [] },
  views: { wouldOrphan: [] },
};

const okReport = {
  dryRun: true,
  ok: true,
  validationErrors: [],
  profiles: {
    create: ["client"],
    reused: [],
    conflicts: [],
    deferred: [],
    scopeConflicts: [],
  },
  entityLinks: { unresolved: [] },
  views: { wouldOrphan: [] },
};

describe("POST /packages/apply — LIVE preflight gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 422 on a preflight LIVE failure and never reaches permission/materialize", async () => {
    mockPreflight.mockResolvedValue(conflictReport);
    const res = await apply(buildApp(), {
      profiles: [
        { slug: "client", displayName: "Client", profileKind: "role" },
      ],
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("Preflight validation failed");
    expect(json.conflicts).toHaveLength(1);
    // The gate fires BEFORE governance + materialize.
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("force:true does NOT bypass a LIVE structural failure (still 422)", async () => {
    mockPreflight.mockResolvedValue(conflictReport);
    const res = await apply(buildApp(), {
      force: true,
      profiles: [
        { slug: "client", displayName: "Client", profileKind: "role" },
      ],
    });
    expect(res.status).toBe(422);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when preflight is ok", async () => {
    mockPreflight.mockResolvedValue(okReport);
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    mockMaterialize.mockResolvedValue({
      status: "created",
      workspaceId: "ws-1",
      created: { outcome: "created" },
    });
    mockApplyPost.mockResolvedValue({});

    const res = await apply(buildApp(), {
      profiles: [{ slug: "client", displayName: "Client" }],
    });
    expect(res.status).toBe(201);
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    expect(mockMaterialize).toHaveBeenCalledTimes(1);
  });
});
