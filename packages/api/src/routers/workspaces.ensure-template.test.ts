/**
 * `workspaces.ensureTemplate` (tRPC, a MUTATION) + its Hub mirror
 * `POST /workspaces/ensure-template` — TEMPLATE-LIFECYCLE Contract B.
 *
 * The standing read is proven on PGlite (`ensure-template-standing.pglite.test.ts`);
 * here, the procedure's wiring around it:
 *   • a non-`available` standing is answered as-is — retired / not_in_catalog /
 *     unknown / exists / installed never reach the install door;
 *   • `available` without `install` is `missing` (with the card), nothing gated;
 *   • an agent or app key's install is `proposed` (the governed gate filed it),
 *     and nothing is installed;
 *   • a person's install goes through `installFromCatalog`'s body (the ONE
 *     template apply, W3) with the CATALOG's package (the caller sends none),
 *     and answers from the standing read AFTER it: installed (with the stored
 *     stamp / drift) or, when not installed yet, installing;
 *   • the Hub mirror is a transport: it reaches the same procedure with the
 *     acting agent, and a proposal answers 202.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  standing: vi.fn(),
  resolve: vi.fn(),
  perm: vi.fn(),
  create: vi.fn(),
}));

// The protected middleware's read-only guard reads the pod's split-brain row.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: async () => false,
}));
vi.mock("../services/ensure-template.js", () => ({
  readTemplateStanding: (...a: unknown[]) => m.standing(...a),
}));
vi.mock("../services/capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: (...a: unknown[]) => m.resolve(...a),
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: (...a: unknown[]) => m.perm(...a),
}));
vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: async () => undefined,
}));
// The install door's apply: record what it was handed.
vi.mock("./workspaces/template-door.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspaces/template-door.js")>()),
  applyTemplateForTrpc: (...a: unknown[]) => m.create(...a),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { workspaceCatalogRouter } from "./workspaces.js";
import { registerWorkspacesEnsureTemplateRoutes } from "./hub-protocol/rest/workspaces-ensure-template.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";

const CARD = {
  slug: "crm",
  name: "CRM",
  description: "Relationships",
  icon: "users",
};
const CATALOG_DEF = { name: "CRM", profiles: [{ slug: "deal" }], _meta: {} };

function caller(agentUserId?: string) {
  return workspaceCatalogRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    ...(agentUserId ? { agentUserId } : {}),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.standing.mockResolvedValue({ status: "available", template: CARD });
  m.resolve.mockResolvedValue({
    packageDefinition: CATALOG_DEF,
    version: "v2",
  });
  m.perm.mockResolvedValue({ granted: true });
  m.create.mockResolvedValue({
    workspaceId: "ws-new",
    outcome: "created",
    materializeStatus: "created",
    dependencies: [],
    layer2: { status: "skipped" },
    finished: null,
    warning: null,
  });
});

describe("workspaces.ensureTemplate", () => {
  it("is a mutation (the SDK calls `.mutate`)", () => {
    expect(
      workspaceCatalogRouter._def.procedures.ensureTemplate._def.type
    ).toBe("mutation");
  });

  it.each([
    [{ status: "retired", replacedBy: "ecosystem", reason: "Folded." }],
    [{ status: "not_in_catalog" }],
    [{ status: "unknown" }],
    [
      {
        status: "exists",
        workspaceId: "ws-twin",
        workspaceName: "My CRM",
        guidance: "Use it.",
      },
    ],
    [
      {
        status: "installed",
        workspaceId: "ws-1",
        version: "v1",
        drifted: true,
        lifecycle: "current",
        replacedBy: null,
      },
    ],
  ])(
    "answers a %o standing as-is, even with install — never installs",
    async (s) => {
      m.standing.mockResolvedValue(s);
      expect(
        await caller().ensureTemplate({ slug: "crm", install: true })
      ).toEqual(s);
      expect(m.perm).not.toHaveBeenCalled();
      expect(m.create).not.toHaveBeenCalled();
    }
  );

  it("available without install is `missing`, with the card; nothing gated", async () => {
    expect(await caller().ensureTemplate({ slug: "crm" })).toEqual({
      status: "missing",
      template: CARD,
    });
    expect(m.perm).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("an agent or app key's install is PROPOSED with the catalog definition; nothing installed", async () => {
    m.perm.mockResolvedValue({
      proposalId: "prop-1",
      reviewUrl: "https://pod.test/open/prop-1",
    });
    const res = await caller("agent-1").ensureTemplate({
      slug: "crm",
      install: true,
      reason: "The CRM app runs on it",
    });
    expect(res).toEqual({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod.test/open/prop-1",
    });
    const gate = m.perm.mock.calls[0][0];
    expect(gate).toMatchObject({
      userId: "user-1",
      agentUserId: "agent-1",
      subjectType: "workspace",
      action: "create",
    });
    expect(gate.data).toMatchObject({
      packageSlug: "crm",
      source: "packages.apply",
      reason: "The CRM app runs on it",
    });
    expect(gate.data.definition.profiles).toEqual(CATALOG_DEF.profiles);
    expect(gate.data.definition._meta).toMatchObject({
      slug: "crm",
      version: "v2",
    });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("a person's install goes through the catalog install door and answers the standing it left", async () => {
    const installed = {
      status: "installed",
      workspaceId: "ws-new",
      version: "v2",
      drifted: false,
      lifecycle: "current",
      replacedBy: null,
    };
    m.standing
      .mockResolvedValueOnce({ status: "available", template: CARD })
      .mockResolvedValueOnce(installed);
    const res = await caller().ensureTemplate({ slug: "crm", install: true });
    expect(res).toEqual(installed);
    expect(m.create).toHaveBeenCalledTimes(1);
    const applied = m.create.mock.calls[0][0];
    expect(applied.definition).toMatchObject({
      profiles: CATALOG_DEF.profiles,
      _meta: { slug: "crm", version: "v2" },
    });
    expect(applied.identity).toMatchObject({
      packageSlug: "crm",
      packageVersion: "v2",
    });
    // Layer 2 is the catalog package parsed through the Hub door's schema.
    expect(applied.layerTwoBody).toMatchObject({ _meta: { slug: "crm" } });
  });

  it("an install whose layers are not finished yet answers `installing`, never an assumed version", async () => {
    // The standing read after the apply does not see it installed yet.
    expect(
      await caller().ensureTemplate({ slug: "crm", install: true })
    ).toEqual({
      status: "installing",
      workspaceId: "ws-new",
    });
  });

  it("a denied gate is an error, never `missing`", async () => {
    m.perm.mockResolvedValue({ denied: true, reason: "no" });
    await expect(
      caller().ensureTemplate({ slug: "crm", install: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("POST /workspaces/ensure-template (Hub mirror)", () => {
  function app(agentUserId?: string): HubHono {
    const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    a.use("/*", async (c, next) => {
      c.set("userId", "user-1");
      if (agentUserId) c.set("agentUserId", agentUserId);
      c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
      await next();
    });
    registerWorkspacesEnsureTemplateRoutes(a);
    return a;
  }
  const post = (a: HubHono, body: unknown) =>
    a.request("/workspaces/ensure-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("reaches the same procedure with the acting agent; a proposal answers 202", async () => {
    m.perm.mockResolvedValue({
      proposalId: "prop-1",
      reviewUrl: "https://pod.test/open/prop-1",
    });
    const res = await post(app("agent-1"), { slug: "crm", install: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    expect(m.perm.mock.calls[0][0].agentUserId).toBe("agent-1");
  });

  it("a read answers 200 with the standing", async () => {
    const res = await post(app(), { slug: "crm" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "missing", template: CARD });
  });

  it("a denied gate is a 403 with the reason, never a standing", async () => {
    m.perm.mockResolvedValue({ denied: true, reason: "not allowed" });
    const res = await post(app(), { slug: "crm", install: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not allowed");
  });

  it("a malformed body is a 400", async () => {
    expect((await post(app(), { install: true })).status).toBe(400);
  });
});
