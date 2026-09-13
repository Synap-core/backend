/**
 * GET /runs forwards the lens (`workspaceId` / `projectId` / `subjectEntityId`)
 * to `listRuns`, like tRPC `runs.list` — it used to drop it, so the Hub feed was
 * unfiltered while the browser's was not.
 *
 * Seam: the real route, from the query string to the service input. The DB
 * predicates each scope key compiles to are `listRuns`' own (not re-tested
 * here — `services/runs/__tests__`).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../services/runs/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listRuns: vi.fn(async () => []),
}));

import { listRuns } from "../../../services/runs/index.js";
import { registerRunsRoutes } from "./runs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    c.set("userId", USER);
    await next();
  });
  registerRunsRoutes(app);
  return app;
}

beforeEach(() => {
  vi.mocked(listRuns).mockClear();
});

describe("GET /runs scope", () => {
  it("forwards workspaceId / projectId / subjectEntityId as scope, under the user floor", async () => {
    const res = await buildApp().request(
      `/runs?workspaceId=${WS}&projectId=${PROJECT}&status=cancelled`
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(listRuns).mock.calls[0]![0]).toMatchObject({
      userId: USER,
      status: "cancelled",
      scope: { workspaceId: WS, projectId: PROJECT },
    });
  });

  it("no lens ⇒ no scope key (the whole user feed)", async () => {
    await buildApp().request("/runs");
    expect(vi.mocked(listRuns).mock.calls[0]![0]).not.toHaveProperty("scope");
  });

  it("a malformed id is a 400, never a silently unfiltered feed", async () => {
    const res = await buildApp().request("/runs?workspaceId=not-a-uuid");
    expect(res.status).toBe(400);
    expect(listRuns).not.toHaveBeenCalled();
  });
});
