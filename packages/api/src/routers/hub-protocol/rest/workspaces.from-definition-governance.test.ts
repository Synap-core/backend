/**
 * SECURITY (D6) — hub `POST /workspaces/from-definition` is governed.
 *
 * Before: the route checked only the `hub-protocol.write` scope (which every
 * agent key carries), never called `checkPermissionOrPropose`, and installed
 * the definition — minting every declared profile — for an agent with no
 * review. Now it goes through the gate like `POST /packages/apply`, and an
 * agent whose definition declares a profile slug with no live row is FORCED to
 * a proposal (approval re-materialises through the `workspace/create` executor
 * as the human approver).
 *
 * Drives the REAL route through `registerWorkspacesRoutes`; only the gate, the
 * install service and the profile lookup are replaced, and the assertions are
 * on what reached them.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: {} as Record<string, unknown>,
  installCalls: [] as Array<Record<string, unknown>>,
  liveSlugs: new Set<string>(),
  verdict: { action: "create" } as Record<string, unknown>,
  installError: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeProfileRepository {
    async findActiveBySlugAnyScope(slug: string) {
      return h.liveSlugs.has(slug) ? [{ id: `p-${slug}`, slug }] : [];
    }
  }
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: async () => ({ id: "u", agentMetadata: null }) },
      },
    },
    getDb: async () => ({}),
    ProfileRepository: FakeProfileRepository,
  };
});

vi.mock("@synap/storage", () => ({ storage: {} }));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return h.gateResult;
    },
  };
});

vi.mock(
  "../../../services/workspace-creation-service.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      createWorkspaceFromDefinitionIdempotent: async (
        input: Record<string, unknown>
      ) => {
        h.installCalls.push(input);
        if (h.installError) throw h.installError;
        return { workspaceId: "ws-new", created: true };
      },
      // One-space-per-domain verdict is proven on PGlite
      // (one-space-per-domain.pglite.test.ts); this suite is about D6.
      checkOneSpacePerDomain: async () => h.verdict,
    };
  }
);

const { registerWorkspacesRoutes } = await import("./workspaces.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function appAs(agentUserId?: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, USER as never);
    if (agentUserId) c.set("agentUserId" as never, agentUserId as never);
    await next();
  });
  registerWorkspacesRoutes(app as never);
  return app;
}

async function post(app: OpenAPIHono, body: Record<string, unknown>) {
  const res = await app.request("/workspaces/from-definition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const definitionMintingKind = {
  proposalId: "idem-1",
  workspaceName: "Podcasts",
  name: "Podcasts",
  profiles: [{ slug: "brand-new-kind", displayName: "Brand new" }],
};

beforeEach(() => {
  h.gateCalls.length = 0;
  h.installCalls.length = 0;
  h.liveSlugs = new Set();
  h.gateResult = {};
  h.verdict = { action: "create" };
  h.installError = null;
});

describe("POST /workspaces/from-definition — D6 governance", () => {
  it("agent + definition declaring a NEW kind → gate forced to propose; 202 proposed; nothing installed", async () => {
    h.gateResult = { proposalId: "prop-1" };
    const { status, body } = await post(appAs(AGENT), definitionMintingKind);
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "workspace",
      action: "create",
      forcePropose: true,
    });
    expect(status).toBe(202);
    expect(body).toEqual({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "/open/prop-1",
    });
    expect(h.installCalls).toEqual([]);
  });

  it("agent + definition reusing only LIVE kinds → gated but not forced (the ladder decides)", async () => {
    h.liveSlugs = new Set(["brand-new-kind"]);
    h.gateResult = { granted: true };
    await post(appAs(AGENT), definitionMintingKind);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      forcePropose: false,
    });
  });

  it("human caller → gate grants, install runs unchanged", async () => {
    h.gateResult = { granted: true };
    const { status } = await post(appAs(), definitionMintingKind);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: undefined,
      forcePropose: false,
    });
    expect(status).toBe(200);
    expect(h.installCalls).toHaveLength(1);
  });
});

describe("POST /workspaces/from-definition — one space per domain", () => {
  it("a refused verdict → 409 typed `exists`, before the gate; nothing installed", async () => {
    const reply = {
      status: "exists",
      workspaceId: "ws-podcasts",
      workspaceName: "Podcasts",
      matchedBy: "name",
      guidance: "g",
    };
    h.verdict = { action: "refuse", reply };
    const { status, body } = await post(appAs(AGENT), definitionMintingKind);
    expect(status).toBe(409);
    expect(body).toEqual({ ...reply, error: reply.guidance });
    expect(h.gateCalls).toEqual([]);
    expect(h.installCalls).toEqual([]);
  });

  it("the verdict is asked without a caller kind — a human is refused like an agent", async () => {
    h.verdict = {
      action: "refuse",
      reply: { status: "exists", guidance: "g" },
    };
    const { status } = await post(appAs(), definitionMintingKind);
    expect(status).toBe(409);
    expect(h.gateCalls).toEqual([]);
  });
});

describe("POST /workspaces/from-definition — template identity (0308)", () => {
  it("a TEMPLATE input with no `_meta.slug` and no `proposalId` → 400 before the verdict, the gate and the install", async () => {
    const { proposalId: _p, ...noKey } = definitionMintingKind;
    void _p;
    for (const body of [
      { ...noKey, templateId: "content-os" },
      { ...noKey, _meta: { version: "h-1" } },
    ]) {
      const { status, body: res } = await post(appAs(), body);
      expect(status).toBe(400);
      expect(String(res.error)).toContain("_meta.slug");
    }
    expect(h.gateCalls).toEqual([]);
    expect(h.installCalls).toEqual([]);
  });

  it("a FREEHAND input (no template marker) without a key still installs", async () => {
    const { proposalId: _p, ...noKey } = definitionMintingKind;
    void _p;
    h.gateResult = { granted: true };
    const { status } = await post(appAs(), noKey);
    expect(status).toBe(200);
  });

  it("`_meta.slug` is the identity: the install and the gate data key on it", async () => {
    const { proposalId: _p, ...noKey } = definitionMintingKind;
    void _p;
    h.gateResult = { granted: true };
    await post(appAs(), { ...noKey, _meta: { slug: "content-os" } });
    expect(h.installCalls[0]).toMatchObject({
      packageSlug: "content-os",
      proposalId: "content-os",
    });
    expect(
      (h.gateCalls[0] as { data: Record<string, unknown> }).data
    ).toMatchObject({ packageSlug: "content-os", proposalId: "content-os" });
  });

  it("a typed identity conflict from the install → 409 naming the holder, never a 500", async () => {
    const { WorkspaceIdentityConflictError } = await import("@synap/database");
    h.gateResult = { granted: true };
    h.installError = new WorkspaceIdentityConflictError(
      "packageSlug",
      "content-os",
      "ws-holder"
    );
    const { status, body } = await post(appAs(), definitionMintingKind);
    expect(status).toBe(409);
    expect(body).toMatchObject({
      reasonCode: "WORKSPACE_IDENTITY_CONFLICT",
      field: "packageSlug",
      existingWorkspaceId: "ws-holder",
    });
  });
});
