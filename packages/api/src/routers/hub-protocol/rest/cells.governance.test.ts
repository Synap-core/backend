/**
 * POST /cells/define governance — the Hub door must apply the SAME
 * `{subjectType: "cell", action: "define"}` gate the MCP door
 * (`mcp/adapter.ts` synap_create_cell) already applies. Two doors, one gate.
 *
 * Proven here:
 *  1. An AGENT caller (body.agentUserId) is gated — on "proposed" NOTHING is
 *     written to widget_definitions and the proposal envelope is returned.
 *  2. The context-injected agentUserId (agent API key) gates identically, so an
 *     agent cannot dodge the gate by omitting the body field.
 *  3. A gate denial is a 403, not a silent write.
 *  4. An OPERATOR caller (no agentUserId — the CLI `synap cell push` path) is
 *     NOT gated and still writes directly, keeping its workspace-access check.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: { granted: true } as Record<string, unknown>,
  workspaceAccess: true,
}));

vi.mock("@synap/database", () => ({
  getDb: async () => ({
    query: { widgetDefinitions: { findMany: async () => [] } },
  }),
  and: (...c: unknown[]) => ({ op: "and", c }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  or: (...c: unknown[]) => ({ op: "or", c }),
}));

vi.mock("@synap/database/schema", () => ({
  widgetDefinitions: {
    typeKey: "typeKey",
    workspaceId: "workspaceId",
    rendererType: "rendererType",
    isActive: "isActive",
    name: "name",
  },
}));

vi.mock("../../../services/cells/define-cell.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/cells/define-cell.js")
  >("../../../services/cells/define-cell.js");
  return {
    validateDeps: actual.validateDeps,
    defineCell: async (input: Record<string, unknown>) => {
      h.defineCalls.push(input);
      return { typeKey: "generated:my-cell", changeType: "created" as const };
    },
  };
});

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  verifyWorkspaceAccess: async () => h.workspaceAccess,
  verifyWorkspaceReadAccess: async () => h.workspaceAccess,
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateResult;
  },
}));

import { registerCellsRoutes } from "./cells.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function buildApp(vars: Partial<HubVariables>): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes ?? ["hub-protocol.write"]);
    c.set("userId", vars.userId ?? "user-1");
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerCellsRoutes(app);
  return app;
}

function defineBody(extra: Record<string, unknown> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "My Cell",
      rendererSource: "export default () => null",
      workspaceId: WS,
      ...extra,
    }),
  };
}

beforeEach(() => {
  h.defineCalls.length = 0;
  h.gateCalls.length = 0;
  h.gateResult = { granted: true };
  h.workspaceAccess = true;
});

describe("POST /cells/define — agent caller is governed", () => {
  it("routes an agent define to a proposal and writes NOTHING", async () => {
    h.gateResult = {
      granted: false,
      proposalId: "proposal-1",
      proposalType: "cell.define",
      summary: 'Define cell "My Cell"',
      reasoning: "needed a chart",
      reviewPath: "/open/proposal-1",
      reviewUrl: "https://pod.example/open/proposal-1",
    };

    const app = buildApp({});
    const res = await app.request(
      "/cells/define",
      defineBody({ agentUserId: AGENT, reasoning: "needed a chart" })
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
      reviewPath: "/open/proposal-1",
    });
    // The renderer source never reached widget_definitions.
    expect(h.defineCalls).toHaveLength(0);
  });

  it("uses the SAME {cell, define} pair as the MCP door and carries the source", async () => {
    h.gateResult = {
      granted: false,
      proposalId: "proposal-2",
      proposalType: "cell.define",
      summary: "s",
      reasoning: "r",
      reviewPath: "/open/proposal-2",
      reviewUrl: "u",
    };

    const app = buildApp({});
    await app.request("/cells/define", defineBody({ agentUserId: AGENT }));

    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "cell",
      action: "define",
      agentUserId: AGENT,
      workspaceId: WS,
      // Agent-authored AI work is branded "intelligence" (matches automation
      // doors), not "api" — consistent provenance for the governed write.
      source: "intelligence",
    });
    // The full define input rides in `data` so the `cell/define` approve-executor
    // can materialize a real cell on approval.
    expect(h.gateCalls[0]?.data).toMatchObject({
      name: "My Cell",
      rendererSource: "export default () => null",
      workspaceId: WS,
    });
  });

  it("gates on the context-injected agentUserId when the body omits it", async () => {
    const app = buildApp({ agentUserId: AGENT });
    await app.request("/cells/define", defineBody());

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({ agentUserId: AGENT });
  });

  it("returns 403 (not a silent write) when the gate denies", async () => {
    h.gateResult = { denied: true, reason: "Permission denied" };

    const app = buildApp({});
    const res = await app.request(
      "/cells/define",
      defineBody({ agentUserId: AGENT })
    );

    expect(res.status).toBe(403);
    expect(h.defineCalls).toHaveLength(0);
  });

  it("applies inline when the gate grants (operator authority via an agent key)", async () => {
    const app = buildApp({});
    const res = await app.request(
      "/cells/define",
      defineBody({ agentUserId: AGENT })
    );

    expect(res.status).toBe(201);
    expect(h.defineCalls).toHaveLength(1);
  });
});

describe("POST /cells/define — operator caller is NOT regressed", () => {
  it("writes directly, without invoking the gate", async () => {
    const app = buildApp({});
    const res = await app.request("/cells/define", defineBody());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      typeKey: "generated:my-cell",
    });
    expect(h.gateCalls).toHaveLength(0);
    expect(h.defineCalls).toHaveLength(1);
  });

  it("still enforces workspace access on the operator path", async () => {
    h.workspaceAccess = false;

    const app = buildApp({});
    const res = await app.request("/cells/define", defineBody());

    expect(res.status).toBe(403);
    expect(h.defineCalls).toHaveLength(0);
  });
});
