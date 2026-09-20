/**
 * Hub REST `POST /automations/create` REFUSES a flow whose capability step
 * names a verb the executing identity cannot run — the same outcome MCP
 * `synap_create_automation` gives, and before any proposal is filed.
 *
 * The refusal is the canonical catalog check inside `automations.create`
 * (`loadFlowValidationResolvers` → `flowValidationErrorMessage`, resolved under
 * `visibleSkillsWhere(createdBy, workspaceId)`), which every door reaches. The
 * MCP handler additionally pre-validates with `validateFlowCapabilities` for
 * marketplace hints — a pre-existing second validator, pinned here only by its
 * outcome.
 *
 * Drives the REAL REST route → real `getCaller` → real hub `createAutomation` →
 * real `automations.create`, and the real MCP handler through the same hub
 * caller. Replaced: the DB rows (which skills exist), the MCP registry read,
 * the catalog cache, and the governance gate, which records what reached it.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
  /** Skill rows the catalog lookup finds (the verbs that exist + are visible). */
  skillRows: [] as Array<{ id: string; name: string }>,
  insertCalls: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const readChain = {
    from: vi.fn(() => readChain),
    where: vi.fn(async () => h.skillRows),
    limit: vi.fn(async () => h.skillRows),
  };
  return {
    ...actual,
    getDb: vi.fn(async () => ({
      select: vi.fn(() => readChain),
      query: { automations: { findFirst: vi.fn(async () => null) } },
      insert: vi.fn(() => {
        h.insertCalls++;
        throw new Error("an agent create must not write a row");
      }),
    })),
  };
});

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return { proposalId: "prop-auto", proposalType: "automation.create" };
    }),
  };
});

vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      listCapabilities: vi.fn(async () =>
        h.skillRows.map((r) => ({
          id: r.id,
          kind: "skill",
          name: r.name,
          verbs: [],
        }))
      ),
    };
  }
);

vi.mock("../../../services/capabilities/catalog-cache-query.js", () => ({
  queryCatalogCache: vi.fn(async () => []),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The act-as grant lookup is a DB read; identity is not what this tests.
    resolveActorId: vi.fn(
      async (agentUserId: string | undefined, userId: string) => ({
        actorId: agentUserId ?? userId,
      })
    ),
  };
});

const { registerAutomationsRoutes } = await import("./automations.js");
const { capabilityHandlers } = await import("../../mcp/handlers/capability.js");
const { hubAutomationsRouter } = await import("../automations.js");
const { createHubProtocolCallerContext } = await import("../utils.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const DATA_CONTRACT = {
  version: 1,
  mode: "react",
  gets: [
    {
      id: "on-demand",
      label: "Operator starts the automation",
      nodeIds: ["trigger"],
      origin: "manual",
      event: "Operator runs it",
    },
  ],
  stores: [],
  reacts: [
    {
      id: "tell-operator",
      label: "Notify the operator",
      nodeIds: ["notify"],
      kind: "notification",
      destination: "operator",
    },
  ],
};

function flowCalling(verbId: string) {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { triggerType: "manual", label: "On demand", config: {} },
      },
      { id: "step", type: "capability", data: { verbId } },
      { id: "notify", type: "output", data: { outputType: "notification" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "step" },
      { id: "e2", source: "step", target: "notify" },
    ],
  };
}

async function restCreate(verbId: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, USER as never);
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerAutomationsRoutes(app as never);
  const res = await app.request("/automations/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Daily digest",
      triggerType: "manual",
      flowDefinition: flowCalling(verbId),
      status: "active",
      metadata: { dataContract: DATA_CONTRACT },
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function mcpCreate(verbId: string) {
  const hubCaller = hubAutomationsRouter.createCaller(
    (await createHubProtocolCallerContext(
      USER,
      ["hub-protocol.write"],
      null
    )) as never
  );
  const result = await capabilityHandlers.synap_create_automation!({
    toolName: "synap_create_automation",
    args: {
      name: "Daily digest",
      triggerType: "manual",
      flowDefinition: flowCalling(verbId),
      metadata: { dataContract: DATA_CONTRACT },
    },
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId: AGENT,
    caller: { automations: hubCaller } as never,
    lensCaller: { automations: hubCaller } as never,
    workspaceAccessible: true,
  });
  return {
    isError: result.isError,
    text: (result.content as Array<{ text: string }>)[0].text,
  };
}

beforeEach(() => {
  h.gateCalls.length = 0;
  h.skillRows = [];
  h.insertCalls = 0;
});

describe("automation create — an unknown capability verb is refused on every agent door", () => {
  it("REST: an agent flow naming an unknown verb is REJECTED (400) before any proposal is filed", async () => {
    const { status, body } = await restCreate("nope.verb");
    expect(status).toBe(400);
    expect(String(body.error)).toContain('"nope.verb"');
    expect(h.gateCalls).toEqual([]);
    expect(h.insertCalls).toBe(0);
  });

  it("REST: an agent key with a resolvable flow gets `proposed`", async () => {
    h.skillRows = [{ id: "skill-ai", name: "ai.generate" }];
    const { status, body } = await restCreate("ai.generate");
    // ONE proposal shape on every hub door: a proposal is success — 202.
    expect(status).toBe(202);
    expect(body).toMatchObject({ status: "proposed", proposalId: "prop-auto" });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "automation",
      action: "create",
    });
    expect(h.insertCalls).toBe(0);
  });

  it("MCP: the same flow is refused as the tool's `{ error }` result, not a thrown tool error", async () => {
    const { isError, text } = await mcpCreate("nope.verb");
    expect(isError).toBeFalsy();
    expect(text).toContain("Automation not created");
    expect(text).toContain('\\"nope.verb\\"');
    expect(h.gateCalls).toEqual([]);
  });

  it("MCP: a resolvable flow reaches governance and returns `proposed`", async () => {
    h.skillRows = [{ id: "skill-ai", name: "ai.generate" }];
    const { isError, text } = await mcpCreate("ai.generate");
    expect(isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({
      status: "proposed",
      proposalId: "prop-auto",
    });
    expect(h.gateCalls[0]).toMatchObject({ agentUserId: AGENT });
  });
});
