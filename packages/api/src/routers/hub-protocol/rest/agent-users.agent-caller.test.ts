/**
 * Hub Protocol REST — an AGENT key may not mint agent keys or widen agent
 * governance (2026-10-06 centralisation audit).
 *
 * THE DEFECT. For an agent key, the hub auth middleware sets `userId` to the
 * linked HUMAN (`resolveKeyIdentity`) and `agentUserId` to the agent. Both
 * doors below authorised on `userId` alone:
 *  - POST /agent-users → `createNamedAgent({ createdByUserId: human })` returns
 *    the human's EXISTING agent of that type with a fresh key, so any agent
 *    could obtain a key AS any sibling agent (e.g. a trusted claude-code) and
 *    inherit its rules, trust and cap.
 *  - PATCH /agent-users/:id/governance → the "creator or pod admin" check passes
 *    as the human, so an agent could write its own auto-approve rules.
 *
 * WHAT IS ASSERTED: refusals write nothing (no mint, no rule sync, no posture
 * write); the legitimate callers still work — a human session mints, and an
 * agent may still TIGHTEN (posture, empty list, writesRequireProposal true),
 * which `synap init` relies on.
 *
 * NOT COVERED: the posture engine itself (postures never auto-approve past the
 * floors) — pinned in @synap/governance-policy postures tests.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  agentRow: null as Record<string, unknown> | null,
  updates: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = () => ({
    from: () => ({
      where: () => ({ limit: async () => (h.agentRow ? [h.agentRow] : []) }),
    }),
  });
  return {
    ...actual,
    db: {
      select: vi.fn(chain),
      update: vi.fn(() => {
        h.updates++;
        return { set: () => ({ where: async () => [] }) };
      }),
    },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  syncAutoApproveRules: vi.fn(async () => undefined),
  applyAgentPosture: vi.fn(async () => ({ posture: "create-with-undo" })),
  readAgentGovernance: vi.fn(async () => null),
}));

vi.mock("../../../services/agent-identity-service.js", () => ({
  createNamedAgent: vi.fn(async () => ({
    agentUserId: AGENT,
    email: "a@synap.agent",
    apiKey: "synap_hub_test_x",
  })),
}));

vi.mock("../../../utils/workspace-role.js", () => ({
  isPodAdmin: vi.fn(async () => false),
}));

import { registerAgentUsersRoutes } from "./agent-users.js";
import { createNamedAgent } from "../../../services/agent-identity-service.js";
import {
  applyAgentPosture,
  syncAutoApproveRules,
} from "@synap/database/agent-governance";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(asAgent: boolean): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", HUMAN);
    if (asAgent) c.set("agentUserId", AGENT);
    await next();
  });
  registerAgentUsersRoutes(app);
  return app;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = 0;
  h.agentRow = {
    id: AGENT,
    agentMetadata: { writesRequireProposal: true },
    createdByUserId: HUMAN,
  };
});

describe("POST /agent-users", () => {
  it("refuses an agent key and mints nothing", async () => {
    const res = await buildApp(true).request(
      "/agent-users",
      json("POST", { name: "x", agentType: "claude-code" })
    );
    expect(res.status).toBe(403);
    expect(vi.mocked(createNamedAgent)).not.toHaveBeenCalled();
  });

  it("still mints for a human caller", async () => {
    const res = await buildApp(false).request(
      "/agent-users",
      json("POST", { name: "Terminal agent", agentType: "claude" })
    );
    expect(res.status).toBe(201);
    expect(vi.mocked(createNamedAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: HUMAN })
    );
  });
});

describe("PATCH /agent-users/:id/governance", () => {
  const patch = (asAgent: boolean, body: unknown) =>
    buildApp(asAgent).request(
      `/agent-users/${AGENT}/governance`,
      json("PATCH", body)
    );

  it.each([
    ["a non-empty auto-approve list", { autoApproveFor: ["entity.create"] }],
    ["writesRequireProposal false", { writesRequireProposal: false }],
  ])("refuses an agent writing %s, and writes nothing", async (_l, body) => {
    const res = await patch(true, body);
    expect(res.status).toBe(403);
    expect(vi.mocked(syncAutoApproveRules)).not.toHaveBeenCalled();
    expect(h.updates).toBe(0);
  });

  it("lets an agent choose a named posture (synap init)", async () => {
    const res = await patch(true, { posture: "create-with-undo" });
    expect(res.status).toBe(200);
    expect(vi.mocked(applyAgentPosture)).toHaveBeenCalled();
  });

  it("lets an agent clear its list without loosening the stored dial", async () => {
    const res = await patch(true, { autoApproveFor: [] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      writesRequireProposal: true,
    });
  });

  it("still lets the human creator widen", async () => {
    const res = await patch(false, {
      autoApproveFor: ["entity.create"],
      writesRequireProposal: false,
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(syncAutoApproveRules)).toHaveBeenCalled();
  });
});
