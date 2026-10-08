/**
 * Hub `POST /runs/:runId/cancel` — WHO may call it. Stopping work is a
 * person's call: an agent key, the Intelligence Service's `is_internal` key
 * and a pod-wide `system` key (both can act as ANY user) are refused before
 * anything is read. Whose run it is, is decided by the ONE floor inside
 * `cancelRun` (its own suite: `services/agent-dispatch/__tests__/
 * cancel-run.pglite.test.ts`) — this file pins that a person's call reaches it
 * with the person's own id.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  reads: 0,
}));

vi.mock("../../../services/agent-dispatch/cancel-run.js", () => ({
  cancelRun: async (p: Record<string, unknown>) => {
    h.calls.push(p);
    return { status: "not_found" };
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        playbookRuns: {
          findFirst: async () => {
            h.reads += 1;
            return { id: RUN, workspaceId: null };
          },
        },
      },
    },
  };
});

import { registerRunsRoutes } from "./runs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function buildApp(vars: Record<string, unknown>): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.write"]);
    c.set("userId", USER);
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerRunsRoutes(app);
  return app;
}
const cancel = (vars: Record<string, unknown>) =>
  buildApp(vars).request(`/runs/${RUN}/cancel`, { method: "POST" });

beforeEach(() => {
  h.calls.length = 0;
  h.reads = 0;
});

describe("POST /runs/:runId/cancel — callers", () => {
  it.each([
    ["an agent key", { agentUserId: "33333333-3333-4333-8333-333333333333" }],
    ["the IS's is_internal key", { keyType: "is_internal", apiKeyId: "k" }],
    ["a pod-wide system key", { keyType: "system", apiKeyId: "k" }],
  ])("%s is refused before anything is read", async (_label, vars) => {
    const res = await cancel(vars);
    expect(res.status).toBe(403);
    expect(h.reads).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it("a person's call reaches the ONE floor with their own id (a run with no workspace is no exception)", async () => {
    const res = await cancel({ keyType: "user_pat", apiKeyId: "k" });
    expect(h.calls).toEqual([{ runId: RUN, userId: USER }]);
    expect(res.status).toBe(404);
  });
});
