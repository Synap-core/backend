/**
 * POST /packages/apply never records the caller's version LABEL.
 *
 * INCIDENT (2026-10-06): the CLI sent its stale bundled content-os labelled
 * `_meta.version: "h-448ffcae9220"` (the catalog's). The door passed the label
 * straight to the proposal data, the materialize stamp and the post-workspace
 * layers, so the pod recorded a stale layout as up to date. The door now
 * replaces the label with `appliedPackageVersion(raw body)` on every path.
 * Same isolated-Hono harness as `packages.instance-name.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPreflight,
  mockCheckPermission,
  mockMaterialize,
  mockApplyPost,
  mockVerdict,
} = vi.hoisted(() => ({
  mockVerdict: vi.fn(),
  mockPreflight: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockMaterialize: vi.fn(),
  mockApplyPost: vi.fn(),
}));

vi.mock("../../../services/preflight-compose-target.js", () => ({
  resolvePreflightComposeTarget: vi.fn(),
}));
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
import { appliedPackageVersion } from "../../../services/applied-package-version.js";

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

const CATALOG_LABEL = "h-448ffcae9220";
const TARGET = "8f894661-db21-4f6d-ba30-5334f7b67bef";
/** The stale bundle the CLI sent: no primarySurface, labelled with the catalog's version. */
const STALE = {
  _meta: { slug: "content-os", version: CATALOG_LABEL },
  workspaceName: "Content OS",
  layoutConfig: { primarySurface: null },
  profiles: [{ slug: "post", displayName: "Post" }],
};

function apply(body: Record<string, unknown>) {
  return buildApp().request("/packages/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /packages/apply — the stamp is derived, never the caller's label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreflight.mockResolvedValue({
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
    });
    mockVerdict.mockResolvedValue({ action: "create" });
    mockApplyPost.mockResolvedValue({});
    mockMaterialize.mockResolvedValue({
      status: "created",
      workspaceId: TARGET,
      created: { workspaceId: TARGET, created: false, outcome: "reconciled" },
    });
  });

  const derived = appliedPackageVersion({
    ...STALE,
    targetWorkspaceId: TARGET,
  });

  it("non-vacuity: the stale definition's own version differs from the label it carried", () => {
    expect(derived).toMatch(/^h-[0-9a-f]{12}$/);
    expect(derived).not.toBe(CATALOG_LABEL);
  });

  it("governed (proposal) path: the replayed data + definition carry the derived version", async () => {
    mockCheckPermission.mockResolvedValue({ proposalId: "prop-1" });
    const res = await apply({ ...STALE, targetWorkspaceId: TARGET });
    expect(res.status).toBeLessThan(300);
    const data = mockCheckPermission.mock.calls[0][0].data;
    expect(data.packageVersion).toBe(derived);
    expect(data.definition._meta.version).toBe(derived);
  });

  it("granted path: materialize stamps + post-workspace layers get the derived version", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    await apply({ ...STALE, targetWorkspaceId: TARGET });
    expect(mockMaterialize.mock.calls[0][0].packageVersion).toBe(derived);
    expect(mockApplyPost).toHaveBeenCalledTimes(1);
    const post = mockApplyPost.mock.calls[0][0] as {
      body: { _meta?: { version?: string } };
    };
    expect(post.body._meta?.version).toBe(derived);
  });

  it("no label sent ⇒ still no stamp (omit-is-silence unchanged)", async () => {
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    await apply({ ...STALE, _meta: { slug: "content-os" } });
    expect(mockMaterialize.mock.calls[0][0].packageVersion).toBeUndefined();
  });
});
