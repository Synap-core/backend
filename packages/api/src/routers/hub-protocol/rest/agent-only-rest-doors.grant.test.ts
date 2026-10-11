/**
 * Hub REST write doors whose only gate was agent-shaped — a body agentUserId
 * (connectors tool-execute), an agent-only scope check (ai-providers
 * credential overrides) or "an agent key cannot …" (agent-users create /
 * governance, focus-session answer) — now bound every key by its grant.
 * Driven through the real routes, the real grant check and the real
 * request-grant scope (`runWithGrant`).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dispatches: [] as Array<Record<string, unknown>>,
  agentsCreated: 0,
}));

vi.mock("../../../connectors/external-dispatch.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  triggerProviderAction: async (input: Record<string, unknown>) => {
    h.dispatches.push(input);
    return { success: true, status: 200, data: {}, headers: {} };
  },
}));
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createNamedAgent: async () => {
    h.agentsCreated += 1;
    return { agentUserId: "a", email: "e", apiKey: "k" };
  },
}));

import { runWithGrant, type KeyGrant } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";
import { registerConnectorsRoutes } from "./connectors.js";
import { registerAiProvidersRoutes } from "./ai-providers.js";
import { registerAgentUsersRoutes } from "./agent-users.js";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("*", async (c, next) => {
    c.set("scopes", [
      "hub-protocol.write",
      "hub-protocol.read",
      "providers.write",
    ]);
    c.set("userId", USER);
    c.set("keyType" as never, "user_pat" as never);
    await next();
  });
  registerConnectorsRoutes(a);
  registerAiProvidersRoutes(a);
  registerAgentUsersRoutes(a);
  registerFocusSessionsRoutes(a);
  return a;
}

const grantOf = (permissions: string[]) =>
  ({
    scopes: [
      { permissions, workspaceIds: null, projectIds: null, entityIds: null },
    ],
    clientId: null,
  }) as KeyGrant;

const send = (method: string, path: string, body: unknown) =>
  app().request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const NARROW = grantOf(["entity", "session.read"]);

beforeEach(() => {
  h.dispatches.length = 0;
  h.agentsCreated = 0;
});

describe("a person's key is bounded by its grant on agent-shaped REST doors", () => {
  it("POST /connectors/tool-execute needs capability.run — nothing dispatched", async () => {
    const call = () =>
      send("POST", "/connectors/tool-execute", {
        provider: "gmail",
        method: "POST",
        path: "/send",
        agentUserId: AGENT,
      });
    const res = await runWithGrant(NARROW, call);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("capability.run"),
    });
    expect(h.dispatches).toHaveLength(0);
  });

  it("POST /connectors/tool-execute: a grant naming capability.run dispatches", async () => {
    const res = await runWithGrant(grantOf(["capability.run"]), () =>
      send("POST", "/connectors/tool-execute", {
        provider: "gmail",
        method: "GET",
        path: "/x",
      })
    );
    expect(res.status).toBe(200);
    expect(h.dispatches).toHaveLength(1);
  });

  it("PATCH /ai-providers/credentials needs ai_provider.update", async () => {
    const res = await runWithGrant(NARROW, () =>
      send("PATCH", "/ai-providers/credentials", {
        providerId: "openrouter",
        apiKey: "sk-x",
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("ai_provider.update"),
    });
  });

  it("POST /agent-users mints a key: needs api_key.create — no agent created", async () => {
    const res = await runWithGrant(NARROW, () =>
      send("POST", "/agent-users", { name: "Bot" })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("api_key.create"),
    });
    expect(h.agentsCreated).toBe(0);
    const ok = await runWithGrant(grantOf(["api_key.create"]), () =>
      send("POST", "/agent-users", { name: "Bot" })
    );
    expect(ok.status).toBe(201);
    expect(h.agentsCreated).toBe(1);
  });

  it("POST /focus-sessions/:id/outputs/answer needs session.update", async () => {
    const res = await runWithGrant(NARROW, () =>
      send("POST", `/focus-sessions/${SESSION}/outputs/answer`, {
        expectedLabel: "x",
        text: "y",
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("session.update"),
    });
  });
});
