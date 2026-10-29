/**
 * Hub `POST /focus-sessions` asks the service to require a criterion for an
 * AGENT key's start only (F11, `requireCriteria`): a person's key and the
 * capture path (`X-Capture: 1`, a person capturing through a key) are exempt.
 * A NO_CRITERIA refusal comes back as a 400 `{status: "refused", reasonCode}`.
 *
 * No database: the service is mocked at its module seam (the rule itself:
 * `create-session.require-criteria.pglite.test.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const AGENT_ID = "agent-1";

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  refuse: false,
}));

vi.mock("../../../services/focus-sessions/create-session.js", async () => ({
  createFocusSession: async (p: Record<string, unknown>) => {
    h.created.push(p);
    if (h.refuse) {
      throw Object.assign(new Error("Not started: say what done means."), {
        code: "BAD_REQUEST",
        reasonCode: "NO_CRITERIA",
      });
    }
    return { status: "created", session: { id: "s-1" } };
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

const post = (agent: boolean, headers: Record<string, string> = {}) =>
  app(agent).request("/focus-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ userId: USER_ID, projectId: "p-1", goal: "Do it" }),
  });

beforeEach(() => {
  h.created = [];
  h.refuse = false;
});

describe("Hub POST /focus-sessions — an agent's start declares what done means", () => {
  it("an agent key's start asks the service to require a criterion", async () => {
    await post(true);
    expect(h.created[0]?.requireCriteria).toBe(true);
  });

  it("a person's key is exempt", async () => {
    await post(false);
    expect(h.created[0]?.requireCriteria).toBe(false);
  });

  it("the capture path is exempt", async () => {
    await post(true, { "X-Capture": "1" });
    expect(h.created[0]?.requireCriteria).toBe(false);
  });

  it("NO_CRITERIA is a 400 refusal with the service's sentence", async () => {
    h.refuse = true;
    const res = await post(true);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: "refused",
      reasonCode: "NO_CRITERIA",
      error: "Not started: say what done means.",
    });
  });
});
