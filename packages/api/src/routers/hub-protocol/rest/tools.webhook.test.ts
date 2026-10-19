/**
 * The Hub REST doors of the inbound-webhook mint (Eve / CLI / IS):
 *
 *  - `POST /tools/:id/webhook` reaches `provisionInboundWebhook` through the
 *    REAL `toolsRouter.provisionWebhook` procedure, as the acting user, with
 *    `rotate` threaded, and maps its refusals to HTTP (404 / 403 / 412);
 *  - `POST /capabilities/apply` answers with `webhooks`: the REAL
 *    `applyCapabilityDefinition` → `provisionInstalledToolWebhooks` →
 *    `provisionInboundWebhook` run for each installed webhook tool (only the
 *    applier is stubbed). The pod here has no PUBLIC_URL, so the door refuses
 *    before any read — which is also the per-tool failure report.
 *
 * The mint itself (visibility, write gate, merge, route agreement) is covered
 * on PGlite by services/webhooks/provision-inbound-webhook.pglite.test.ts.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const TOOL = "0bbbbbbb-0000-4000-8000-000000000002";
const URL = `https://pod.example.test/api/webhooks/postiz/${"t".repeat(43)}`;

const provision = vi.fn();
vi.mock(
  "../../../services/webhooks/provision-inbound-webhook.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/webhooks/provision-inbound-webhook.js")
      >();
    return {
      ...actual,
      provisionInboundWebhook: (...a: unknown[]) => provision(...a),
    };
  }
);

const applyCapability = vi.fn();
vi.mock(
  "../../../services/capabilities/create-from-definition.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/capabilities/create-from-definition.js")
      >();
    return {
      ...actual,
      createCapabilityFromDefinition: (...a: unknown[]) =>
        applyCapability(...a),
    };
  }
);
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
// The procedure middlewares read live PG; pass them through (same stub as
// capability-containers.governance.test.ts).
vi.mock("../../../middleware/read-only-guard.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../../../middleware/audit-log.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    resolveActingContext: async () => ({
      ok: true,
      userId: USER,
      workspaceId: null,
      role: "owner",
    }),
  };
});
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    createHubProtocolCallerContext: async (
      userId: string,
      scopes: string[]
    ) => ({
      authenticated: true,
      userId,
      scopes,
    }),
  };
});

const { registerToolsRoutes } = await import("./tools.js");
const { registerCapabilitiesRoutes } = await import("./capabilities.js");

function makeApp(scopes = ["hub-protocol.write"]) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, USER as never);
    c.set("scopes" as never, scopes as never);
    await next();
  });
  registerToolsRoutes(app as never);
  registerCapabilitiesRoutes(app as never);
  return app;
}

const mint = (body?: unknown, scopes?: string[], id = TOOL) =>
  makeApp(scopes).request(`/tools/${id}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const ok = {
  provider: "postiz",
  url: URL,
  rotated: false,
  missingConfig: [],
  setupStep: "In Postiz, open Settings → Webhooks …",
};

beforeEach(() => {
  provision.mockReset();
  applyCapability.mockReset();
});

describe("POST /tools/:id/webhook", () => {
  it("mints through the tools procedure as the acting user and returns the URL", async () => {
    provision.mockResolvedValue(ok);
    const res = await mint();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ok);
    expect(provision).toHaveBeenCalledWith({
      userId: USER,
      toolId: TOOL,
      rotate: undefined,
    });
  });

  it("threads rotate", async () => {
    provision.mockResolvedValue({ ...ok, rotated: true });
    const res = await mint({ rotate: true });
    expect(res.status).toBe(200);
    expect(provision).toHaveBeenCalledWith({
      userId: USER,
      toolId: TOOL,
      rotate: true,
    });
  });

  it.each([
    ["NOT_FOUND", 404],
    ["FORBIDDEN", 403],
    ["PRECONDITION_FAILED", 412],
    ["BAD_REQUEST", 400],
  ] as const)("a %s refusal answers %i", async (code, status) => {
    provision.mockRejectedValue(new TRPCError({ code, message: "no" }));
    expect((await mint()).status).toBe(status);
  });

  it("refuses without write scope, and a non-uuid id, before minting", async () => {
    expect((await mint({}, ["hub-protocol.read"])).status).toBe(403);
    expect((await mint({}, undefined, "not-a-uuid")).status).toBe(400);
    expect(provision).not.toHaveBeenCalled();
  });
});

describe("POST /capabilities/apply — webhooks", () => {
  it("reports each installed webhook tool, a refusal included, without failing the install", async () => {
    delete process.env.PUBLIC_URL;
    applyCapability.mockResolvedValue({
      capabilityKey: "postiz",
      created: {
        container: null,
        vault: [],
        mcpServers: [],
        tools: [
          { name: "postiz", status: "created", toolId: TOOL, proposalId: null },
        ],
        skills: [],
        playbooks: [],
        automations: [],
      },
      proposals: [],
    });
    const res = await makeApp().request("/capabilities/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition: { key: "postiz", name: "Postiz" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: unknown[] };
    expect(body.webhooks).toEqual([
      {
        tool: "postiz",
        toolId: TOOL,
        provider: "postiz",
        error: expect.stringMatching(/PUBLIC_URL/),
      },
    ]);
  });
});
