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

const {
  mockPreflight,
  mockCheckPermission,
  mockMaterialize,
  mockApplyPost,
  mockComposeTarget,
} = vi.hoisted(() => ({
  mockPreflight: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockMaterialize: vi.fn(),
  mockApplyPost: vi.fn(),
  mockComposeTarget: vi.fn(),
}));

// The ONE finisher (stamp + "active" on convergence) reads and writes the
// workspace row; its behaviour is pinned on PGlite by
// `rest/packages.finish-template-apply.pglite.test.ts`. Out of scope here.
vi.mock("../../../services/template-apply-finisher.js", () => ({
  finishTemplateApply: vi.fn(async () => ({
    state: "converged",
    versionStamped: false,
  })),
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
  // No pending template data change (Contract C gate, proven in
  // `packages.data-changes.test.ts`); this suite is about something else.
  pendingTemplateDataChanges: async () => [],
  findWorkspaceIdentityConflict: async () => null,
  preflightWorkspaceFromDefinition: (...a: unknown[]) => mockPreflight(...a),
}));

// The ONE apply (`applyTemplate`, W2) asks the core for deps/compose only
// (`deferCreate`), then runs its layer one. A "created" answer staged by a
// test is handed to layer one (mocked below), so each test keeps staging the
// space the way it always did.
const shim = vi.hoisted(() => ({
  created: null as null | Record<string, unknown>,
  layerOneArgs: [] as Record<string, unknown>[],
}));
vi.mock("../../../services/template-apply/layer-one.js", () => ({
  applyLayerOne: async (i: Record<string, unknown>) => {
    shim.layerOneArgs.push(i);
    const c = shim.created ?? {};
    return {
      action:
        c.outcome === "created"
          ? { kind: "create" }
          : c.outcome === "unchanged"
            ? { kind: "unchanged", checked: true }
            : { kind: "resync", reason: "stale", reopen: false },
      ...c,
    };
  },
}));
vi.mock("../../../services/template-apply/resolve-target.js", () => ({
  resolveTarget: async () => ({ found: false }),
  findLegacyWorkspaceMatch: async () => null,
}));
vi.mock("../../../services/workspace-materialization-service.js", () => ({
  materializeWorkspaceCore: async (...a: unknown[]) => {
    const r = (await mockMaterialize(...a)) as
      { status?: string; created?: Record<string, unknown> } | undefined;
    if (r?.status !== "created") return r;
    shim.created = r.created ?? null;
    return { status: "resolved", dependencies: [] };
  },
  materializeReportStatus: () => "composed",
  ComposeBaseUnavailableError: class extends Error {},
  DependencyResolutionError: class extends Error {},
  ComposeBaseNotFoundError: class extends Error {},
  ComposeOverlayError: class extends Error {},
}));

vi.mock("../../../services/package-apply-post-workspace.js", () => ({
  applyPackagePostWorkspace: (...a: unknown[]) => mockApplyPost(...a),
  TemplateIncompleteError: class extends Error {},
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) => mockCheckPermission(...a),
}));

vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));

// The one-space verdict reads the DB; it is proven on PGlite
// (one-space-per-domain.pglite.test.ts). This suite is about the preflight gate.
vi.mock(
  "../../../services/workspace-creation-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/workspace-creation-service.js")
    >()),
    checkOneSpacePerDomain: async () => ({ action: "create" }),
  })
);

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
      // A template body carries its slug (0308: no slug + no target = 400).
      _meta: { slug: "client-pack" },
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
      _meta: { slug: "client-pack" },
      force: true,
      profiles: [
        { slug: "client", displayName: "Client", profileKind: "role" },
      ],
    });
    expect(res.status).toBe(422);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("hands the preflight the compose target materialize will reconcile onto (--onto)", async () => {
    // business-model --onto Foundation: the live 422. The preflight can only
    // resolve foundation's kinds if it is told WHERE the apply layers.
    mockComposeTarget.mockResolvedValue({ workspaceId: "ws-foundation" });
    mockPreflight.mockResolvedValue(conflictReport);
    await apply(buildApp(), {
      targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
      dependencies: [{ slug: "foundation", relation: "compose" }],
      entityLinks: [
        {
          sourceProfileSlug: "offer",
          targetProfileSlug: "audience",
          type: "rests_on",
        },
      ],
    });
    expect(mockComposeTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        targetWorkspaceId: "8f894661-db21-4f6d-ba30-5334f7b67bef",
      })
    );
    expect(mockPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        composeTarget: { workspaceId: "ws-foundation" },
      })
    );
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
      // A template body carries its slug (0308: no slug + no target = 400).
      _meta: { slug: "client-pack" },
      profiles: [{ slug: "client", displayName: "Client" }],
    });
    expect(res.status).toBe(201);
    expect(mockCheckPermission).toHaveBeenCalledTimes(1);
    expect(mockMaterialize).toHaveBeenCalledTimes(1);
  });
});
