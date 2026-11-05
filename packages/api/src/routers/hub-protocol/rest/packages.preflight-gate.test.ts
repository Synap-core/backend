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
// (one-space-per-domain.pglite.test.ts). This suite is about the preflight gate
// (and, below, that an app's install answers that verdict before governance).
const oneSpace = vi.hoisted(() => ({
  verdict: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({
    action: "create",
  })),
}));
vi.mock(
  "../../../services/workspace-creation-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/workspace-creation-service.js")
    >()),
    checkOneSpacePerDomain: (...a: unknown[]) => oneSpace.verdict(...a),
  })
);

// "Add to my pod" routing (`routeNamedInstall`) reads which space holds a
// slug and the official catalog; both are proven on PGlite
// (propose.beyond-grant.pglite.test.ts). Here: no space holds a slug, and the
// catalog holds `creator-pack`.
const catalogPack = vi.hoisted(() => ({
  _meta: { slug: "creator-pack", version: "creator-pack-2" },
  workspaceName: "Creator pack",
  profiles: [{ slug: "client", displayName: "Client", profileKind: "kind" }],
}));
vi.mock("../../../services/installed-template-space.js", () => ({
  installedTemplateSpace: async () => null,
}));
vi.mock("../../../services/capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async (slug: string) =>
    slug === "creator-pack"
      ? {
          source: "cache",
          version: "creator-pack-2",
          dependencies: [],
          packageDefinition: catalogPack,
          workspaceDefinition: catalogPack,
        }
      : null,
}));

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

/**
 * A body that does not fit `PackageApplySchema` is a 400 naming the field,
 * on BOTH package doors — never a 500 (incident 2026-11-02: `synap market
 * update` sent Content OS, whose Produce Content "draft" stage goal was 5,225
 * characters against the stage schema's 5,000; `PackageApplySchema.parse`
 * threw a ZodError and the app's error handler answered an opaque 500 on
 * `/packages/preflight` and `/packages/apply`). The playbook is the real
 * stage's shape, cut down; the 5,000-character twin is the control that the
 * cap, and nothing else in the body, is what is refused.
 */
describe("POST /packages/{preflight,apply} — a body the schema refuses", () => {
  beforeEach(() => vi.clearAllMocks());

  const contentOsLike = (goalLength: number) => ({
    _meta: { slug: "content-os" },
    playbooks: [
      {
        name: "Produce Content",
        goalTemplate: "Produce content for {platform} from this idea ({post}).",
        stages: [
          {
            key: "draft",
            name: "Draft",
            category: "started",
            subjectStatus: "In Draft",
            gate: { kind: "human" },
            onFail: { toStage: "script" },
            goal: "x".repeat(goalLength),
          },
        ],
      },
    ],
  });

  function post(path: string, body: unknown) {
    return buildApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  for (const path of ["/packages/preflight", "/packages/apply"]) {
    it(`${path}: an over-long stage goal is a 400 that names the field`, async () => {
      const res = await post(path, contentOsLike(5225));
      expect(res.status).toBe(400);
      const json = (await res.json()) as {
        error: string;
        fieldErrors: Record<string, string[]>;
      };
      expect(Object.keys(json.fieldErrors)).toEqual([
        "playbooks.0.stages.0.goal",
      ]);
      expect(json.error).toContain("playbooks.0.stages.0.goal");
      // Refused at the door: nothing past the parse ran.
      expect(mockComposeTarget).not.toHaveBeenCalled();
      expect(mockPreflight).not.toHaveBeenCalled();
      expect(mockCheckPermission).not.toHaveBeenCalled();
    });
  }

  it("/packages/preflight: the same body at the 5,000 cap is read", async () => {
    mockComposeTarget.mockResolvedValue(undefined);
    mockPreflight.mockResolvedValue(okReport);
    const res = await post("/packages/preflight", contentOsLike(5000));
    expect(res.status).not.toBe(400);
    expect(mockPreflight).toHaveBeenCalledTimes(1);
  });

  it("an unreadable JSON body is a 400, not a 500", async () => {
    const res = await buildApp().request("/packages/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"_meta":',
    });
    expect(res.status).toBe(400);
  });
});

/**
 * L7 "Add to my pod": an app that may ask to install a package
 * (`package.install`, pinned to a space as every app grant is) previews what
 * it asks for. It gets what the package brings, and the pod's parts (the
 * target space, the kinds it would reuse, the rows an update would change)
 * said withheld, never read. A key that reads them still gets the whole
 * answer (the other rows of this file run with no grant).
 */
describe("POST /packages/preflight — an app holding package.install", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers what the package brings, and withholds the pod's parts without reading them", async () => {
    const { grantOfScope, runWithGrant } = await import("@synap/database");
    const appGrant = grantOfScope({
      permissions: ["entity.read", "package.install"],
      workspaceIds: ["w1"],
    });
    const res = await runWithGrant(appGrant, () =>
      buildApp().request("/packages/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _meta: { slug: "creator-pack" },
          profiles: [
            { slug: "client", displayName: "Client", profileKind: "kind" },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.pod).toMatchObject({ status: "withheld" });
    expect(json.contents).toBeTruthy();
    expect(json).not.toHaveProperty("profiles");
    expect(json).not.toHaveProperty("apply");
    expect(json).not.toHaveProperty("dataChanges");
    // Nothing of the pod was read for it.
    expect(mockComposeTarget).not.toHaveBeenCalled();
    expect(mockPreflight).not.toHaveBeenCalled();
  });
});

/**
 * L7: a fresh install an app asks for (`package.install`) answers the one
 * space per domain rule like every caller: a live space already holding the
 * pack's domain is the typed `exists` (409), never a second space and never a
 * proposal. The verdict itself is proven on PGlite for any caller
 * (one-space-per-domain.pglite.test.ts, "a live DOMAIN TWIN the caller cannot
 * adopt is REFUSED"); this pins that the app's request meets it BEFORE the
 * gate.
 */
describe("POST /packages/apply — an app's install meets one space per domain first", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers the existing space (409, status exists) and never reaches the gate", async () => {
    const existing = {
      status: "exists",
      workspaceId: "ws-existing",
      guidance: "This domain already has a space: use it.",
    };
    oneSpace.verdict.mockResolvedValueOnce({
      action: "refuse",
      reply: existing,
    });
    const { grantOfScope, runWithGrant } = await import("@synap/database");
    const res = await runWithGrant(
      grantOfScope({
        permissions: ["entity.read", "package.install"],
        workspaceIds: ["w1"],
      }),
      () =>
        apply(buildApp(), {
          _meta: { slug: "creator-pack" },
          profiles: [
            { slug: "client", displayName: "Client", profileKind: "kind" },
          ],
        })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject(existing);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
});

/**
 * L7, review finding 6: what a person-acting app (no agent) holding only
 * `package.install` hands the gate. A catalog reference reaches it as the
 * CATALOG's definition with no untrusted issuer (the person's click may
 * apply it); content the app wrote reaches it with an untrusted issuer, so
 * the gate files one proposal (its rung 4b, proven on PGlite).
 */
describe("POST /packages/apply — a person-acting app's install is fixed by the catalog", () => {
  beforeEach(() => vi.clearAllMocks());
  const appGrant = async () =>
    (await import("@synap/database")).grantOfScope({
      permissions: ["entity.read", "package.install"],
      workspaceIds: ["w1"],
    });

  async function applyAsApp(body: Record<string, unknown>) {
    mockPreflight.mockResolvedValue(okReport);
    mockCheckPermission.mockResolvedValue({ proposalId: "p-1" });
    const { runWithGrant } = await import("@synap/database");
    return runWithGrant(await appGrant(), () => apply(buildApp(), body));
  }
  const gateCall = () =>
    mockCheckPermission.mock.calls[0]![0] as {
      issuer?: { trusted: boolean };
      data: { definition: Record<string, unknown> };
    };

  it("a catalog reference reaches the gate as the catalog's own definition", async () => {
    const res = await applyAsApp({
      _meta: { slug: "creator-pack", version: "creator-pack-2" },
    });
    expect(res.status).toBe(202);
    const call = gateCall();
    expect(call.issuer).toBeUndefined();
    expect(call.data.definition).toMatchObject({
      workspaceName: "Creator pack",
      profiles: catalogPack.profiles,
    });
  });

  it("content the app wrote reaches the gate as an untrusted issuer (one proposal)", async () => {
    const res = await applyAsApp({
      _meta: { slug: "creator-pack" },
      workspaceName: "Mine now",
      profiles: [{ slug: "lead", displayName: "Lead", profileKind: "kind" }],
    });
    expect(res.status).toBe(202);
    const call = gateCall();
    expect(call.issuer).toEqual({ kind: "connector", trusted: false });
    expect(call.data.definition).toMatchObject({ workspaceName: "Mine now" });
  });
});
