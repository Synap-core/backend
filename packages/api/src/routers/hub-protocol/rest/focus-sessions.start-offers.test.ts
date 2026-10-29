/**
 * Hub `POST /focus-sessions` hands back the same START OFFERS as MCP
 * `synap_start_session` (structural plan S5): an agent key's start asks the
 * service for them (`offerStartContext`) and the reply carries `offers` —
 * goals, near sessions, and `homes` for a start that landed in no project —
 * so the CLI sees what MCP sees. A person's key is not offered anything.
 *
 * No database: the service is mocked at its module seam (the offers
 * themselves: `start-offers.homes.pglite.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const AGENT_ID = "agent-1";

const OFFERS = {
  homes: {
    status: "ok",
    total: 1,
    items: [
      {
        kind: "project",
        projectId: "p-1",
        projectName: "Synap",
        reasons: ["3 sessions started from this folder are in this project."],
      },
    ],
  },
  hint: "Suggestions only — nothing was applied.",
};

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/focus-sessions/create-session.js", async () => ({
  createFocusSession: async (p: Record<string, unknown>) => {
    h.created.push(p);
    return {
      status: "created",
      session: { id: "s-1" },
      ...(p.offerStartContext ? { offers: OFFERS } : {}),
    };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(agent: boolean): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agent) c.set("agentUserId", AGENT_ID);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const post = (agent: boolean) =>
  app(agent).request("/focus-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER_ID, projectId: "p-1", goal: "Do it" }),
  });

beforeEach(() => {
  h.created = [];
});

describe("Hub POST /focus-sessions — the start offers reach the REST door (S5)", () => {
  it("an agent key's start asks for the offers and the reply carries them", async () => {
    const res = await post(true);
    expect(res.status).toBe(200);
    expect(h.created[0]?.offerStartContext).toBe(true);
    expect(await res.json()).toMatchObject({ id: "s-1", offers: OFFERS });
  });

  it("a person's key is offered nothing", async () => {
    const res = await post(false);
    expect(h.created[0]?.offerStartContext).toBe(false);
    expect(await res.json()).not.toHaveProperty("offers");
  });
});
