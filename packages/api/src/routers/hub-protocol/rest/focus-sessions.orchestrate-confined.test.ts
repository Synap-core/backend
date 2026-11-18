/**
 * Hub REST `POST /focus-sessions/orchestrate` — a workspace-bound key is
 * confined. The route handed the service no binding, so a key bound to
 * workspace W could pick (and pause) sessions in any space its owner works
 * in. It now passes the key's binding (`keyWorkspaceId`), and the service
 * refuses any picked session outside it (`start-orchestrator.pglite.test.ts`
 * pins that refusal and that nothing is written).
 *
 * DB-free: the service is stubbed; what is under test is what the door
 * hands it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock(
  "../../../services/focus-sessions/start-orchestrator.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    startOrchestrator: vi.fn(async (p: Record<string, unknown>) => {
      h.calls.push(p);
      return {
        status: "started",
        orchestratorSessionId: "o-1",
        channelId: null,
        children: [],
      };
    }),
  })
);

import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const W = "11111111-1111-4111-8111-111111111111";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";

function buildTestApp(keyWorkspaceId: string | null): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.write"]);
    c.set("keyType", "service");
    c.set("keyWorkspaceId", keyWorkspaceId);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

const orchestrate = (app: HubHono) =>
  app.request("/focus-sessions/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionIds: [A, B], brief: "Merge" }),
  });

describe("Hub REST POST /focus-sessions/orchestrate — the key's binding", () => {
  beforeEach(() => {
    h.calls = [];
  });

  it("a key bound to W hands W to the service, which confines every picked session to it", async () => {
    expect((await orchestrate(buildTestApp(W))).status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      userId: "user-1",
      boundWorkspaceId: W,
    });
  });

  it("an unbound key hands no binding (pod-wide, as before)", async () => {
    expect((await orchestrate(buildTestApp(null))).status).toBe(200);
    expect(h.calls[0]).toMatchObject({ boundWorkspaceId: null });
  });
});
