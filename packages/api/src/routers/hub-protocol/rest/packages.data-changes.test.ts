/**
 * Hub Protocol REST — `/packages/apply` + `/packages/preflight` DATA CHANGES
 * (TEMPLATE-LIFECYCLE Contract C): an UPDATE whose template a pending
 * conversion op touches is refused (409, nothing written) until the person
 * accepts each consentable change; accepted ones run BEFORE the template
 * apply; an agent can never consent; destructive ones are operator steps.
 * Same isolated-Hono harness as `packages.template-identity.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPreflight,
  mockCheckPermission,
  mockMaterialize,
  mockApplyPost,
  mockComposeTarget,
  mockVerdict,
  mockHolder,
  mockPending,
  mockRun,
  mockIsPodAdmin,
} = vi.hoisted(() => ({
  mockHolder: vi.fn(),
  mockPending: vi.fn(),
  mockRun: vi.fn(),
  mockIsPodAdmin: vi.fn(),
  mockVerdict: vi.fn(),
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
  preflightWorkspaceFromDefinition: (...a: unknown[]) => mockPreflight(...a),
  // The pending set and the engine run are proven on PGlite
  // (`conversions/data-changes.pglite.test.ts`); `dataChangeConsent` stays REAL.
  findWorkspaceIdentityConflict: (...a: unknown[]) => mockHolder(...a),
  pendingTemplateDataChanges: (...a: unknown[]) => mockPending(...a),
  runConsentedDataChanges: (...a: unknown[]) => mockRun(...a),
}));

// Which space a template update targets (and the proposal it files) is proven
// on PGlite (`workspace-template-update-approve.pglite.test.ts`); this suite is
// about consent, so the update's proposal shape is out of its scope.
vi.mock("../../../services/installed-template-space.js", () => ({
  installedTemplateSpace: async () => null,
}));

vi.mock("../../../utils/workspace-role.js", () => ({
  isPodAdmin: (...a: unknown[]) => mockIsPodAdmin(...a),
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

function post(path: string, app: HubHono, body: Record<string, unknown>) {
  return app.request(path, {
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

const apply = (app: HubHono, body: Record<string, unknown>) =>
  post("/packages/apply", app, body);

const PKG = {
  _meta: { slug: "crm" },
  workspaceName: "CRM",
  profiles: [{ slug: "deal" }, { slug: "client" }, { slug: "lead" }],
};

const DEAL = {
  opKey: "crm.deal-stage.commercial-fold",
  description: "Move each deal's dealStage onto commercialStage.",
  affected: 3,
  destructive: false,
  counts: { entitiesRemapped: 3 },
};
const LEAD = {
  opKey: "w12.lead.lifecycle-stage-fold",
  description: "Move the lead role's lifecycleStage onto leadStage.",
  affected: 1,
  destructive: false,
  counts: { facetsRemapped: 1 },
};
const CHURNED = {
  opKey: "w12.role.churned-into-status",
  description: "Retire the churned role.",
  affected: 2,
  destructive: true,
  counts: { facetsDeactivated: 2 },
  operatorCommand:
    "pnpm --filter @synap/database conversions --only w12.role.churned-into-status",
};

describe("POST /packages/apply — data changes need the person's consent", () => {
  const order: string[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    mockPreflight.mockResolvedValue(okReport);
    mockVerdict.mockResolvedValue({ action: "create" });
    mockApplyPost.mockResolvedValue({});
    mockCheckPermission.mockResolvedValue({ status: "applied" });
    mockHolder.mockResolvedValue({
      field: "packageSlug",
      value: "crm",
      existingWorkspaceId: "ws-crm",
    });
    mockPending.mockResolvedValue([DEAL, LEAD, CHURNED]);
    mockIsPodAdmin.mockResolvedValue(true);
    mockRun.mockImplementation(async (_sql: unknown, keys: string[]) => {
      order.push("run");
      return {
        dryRun: false,
        destructiveTail: false,
        hadError: false,
        results: keys.map((k) => ({
          opKey: k,
          op: "x",
          status: "applied",
          counts: {},
        })),
      };
    });
    mockMaterialize.mockImplementation(async () => {
      order.push("materialize");
      return {
        status: "created",
        workspaceId: "ws-crm",
        created: {
          workspaceId: "ws-crm",
          created: false,
          outcome: "reconciled",
        },
      };
    });
  });

  it("refuses an update with unaccepted changes — 409, nothing governed, run or applied", async () => {
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DATA_CHANGES_NEED_CONSENT");
    expect(body.missing.sort()).toEqual([DEAL.opKey, LEAD.opKey].sort());
    expect(body.needsPerson).toBe(false);
    expect(body.dataChanges.map((c: { opKey: string }) => c.opKey)).toContain(
      CHURNED.opKey
    );
    // The pending set is read for THIS template's profiles.
    expect(mockPending.mock.calls[0][1]).toEqual(["deal", "client", "lead"]);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("partial consent is still a refusal", async () => {
    const res = await apply(buildApp(), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey],
    });
    expect(res.status).toBe(409);
    expect((await res.json()).missing).toEqual([LEAD.opKey]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("with consent: runs exactly the accepted changes BEFORE the template apply", async () => {
    const res = await apply(buildApp(), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey, LEAD.opKey],
    });
    expect(res.status).toBe(201);
    expect(mockRun.mock.calls[0][1]).toEqual([DEAL.opKey, LEAD.opKey]);
    expect(order).toEqual(["run", "materialize"]);
    const body = await res.json();
    expect(body.dataChanges.ran.map((r: { opKey: string }) => r.opKey)).toEqual(
      [DEAL.opKey, LEAD.opKey]
    );
    // The destructive one is printed as an operator step, never run.
    expect(
      body.dataChanges.operatorSteps.map((c: { opKey: string }) => c.opKey)
    ).toEqual([CHURNED.opKey]);
  });

  it("an agent can never consent — 409 even with acceptDataChanges, nothing proposed", async () => {
    const res = await apply(buildApp("agent-1"), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey, LEAD.opKey],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DATA_CHANGES_NEED_CONSENT");
    // It listed everything, so nothing is "missing": the refusal is WHO asked.
    // `needsPerson` is what lets a client say so (dogfood 2026-10-14: the CLI
    // told the agent "you have not agreed" and to re-run the same command).
    expect(body.missing).toEqual([]);
    expect(body.needsPerson).toBe(true);
    expect(mockCheckPermission).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("accepting a destructive change neither runs it nor blocks the update; it is echoed back", async () => {
    // lane-cli's deadlock: a pending destructive op must never stop an update.
    const res = await apply(buildApp(), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey, LEAD.opKey, CHURNED.opKey],
    });
    expect(res.status).toBe(201);
    expect(mockRun.mock.calls[0][1]).toEqual([DEAL.opKey, LEAD.opKey]);
    const body = await res.json();
    expect(body.dataChanges.destructiveAccepted).toEqual([CHURNED.opKey]);
    expect(
      body.dataChanges.operatorSteps.map((c: { opKey: string }) => c.opKey)
    ).toEqual([CHURNED.opKey]);
  });

  it("a destructive-only backlog does not block the update; it is reported", async () => {
    mockPending.mockResolvedValue([CHURNED]);
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(201);
    expect(mockRun).not.toHaveBeenCalled();
    expect((await res.json()).dataChanges.operatorSteps[0].opKey).toBe(
      CHURNED.opKey
    );
  });

  it("only a pod admin may agree — 403 before anything runs", async () => {
    mockIsPodAdmin.mockResolvedValue(false);
    const res = await apply(buildApp(), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey, LEAD.opKey],
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DATA_CHANGES_NEED_POD_ADMIN");
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("a failed change stops the update: the template is not applied", async () => {
    mockRun.mockResolvedValue({
      dryRun: false,
      destructiveTail: false,
      hadError: true,
      results: [
        {
          opKey: DEAL.opKey,
          op: "remapPropertyValues",
          status: "applied",
          counts: {},
        },
        {
          opKey: LEAD.opKey,
          op: "remapFacetPropertyValues",
          status: "error",
          counts: {},
          error: "boom",
        },
      ],
    });
    const res = await apply(buildApp(), {
      ...PKG,
      acceptDataChanges: [DEAL.opKey, LEAD.opKey],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DATA_CHANGES_FAILED");
    expect(body.dataChanges.ran[1]).toMatchObject({
      opKey: LEAD.opKey,
      error: "boom",
    });
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("an unreadable pending set refuses (503) — never read as 'no changes'", async () => {
    mockPending.mockRejectedValue(new Error("ledger down"));
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("DATA_CHANGES_UNREADABLE");
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("a fresh install is not an update: no data-change gate", async () => {
    mockHolder.mockResolvedValue(null);
    const res = await apply(buildApp(), PKG);
    expect(res.status).toBe(201);
    expect(mockPending).not.toHaveBeenCalled();
  });

  it("an install ONTO an existing space is an update", async () => {
    mockHolder.mockResolvedValue(null);
    const res = await apply(buildApp(), {
      ...PKG,
      targetWorkspaceId: "8f1c2f0e-6f7b-4b8a-9d4c-1a2b3c4d5e6f",
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /packages/preflight — the update preview carries dataChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreflight.mockResolvedValue(okReport);
    mockHolder.mockResolvedValue({
      field: "packageSlug",
      value: "crm",
      existingWorkspaceId: "ws-crm",
    });
  });

  it("lists every pending change with its count and destructive flag", async () => {
    mockPending.mockResolvedValue([DEAL, CHURNED]);
    const res = await post("/packages/preflight", buildApp(), PKG);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dataChanges).toEqual([DEAL, CHURNED]);
  });

  it("a failed read is reported, never an empty list", async () => {
    mockPending.mockRejectedValue(new Error("ledger down"));
    const body = await (
      await post("/packages/preflight", buildApp(), PKG)
    ).json();
    expect(body.dataChanges).toBeNull();
    expect(body.dataChangesError).toContain("ledger down");
  });
});
