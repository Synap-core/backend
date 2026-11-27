/**
 * Hub Protocol REST — GET /surfaces, the REST door onto
 * `surfacesForObject` (mocked here; the stores are covered on PGlite by
 * `services/surfaces/for-object.pglite.test.ts`).
 *
 * Pins the door: `hub-protocol.read` is required (403 before any read), the
 * anchor and space reach the service as given, a key bound to one space reads
 * that space (and is refused another), `unavailable` reaches the wire, a bad
 * kind is a 400 and an invisible anchor a 404, never an empty 200.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { surfacesForObject } = vi.hoisted(() => ({
  surfacesForObject: vi.fn(),
}));

vi.mock("../../../services/surfaces/for-object.js", () => ({
  surfacesForObject,
}));

import { registerSurfacesRoutes } from "./surfaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const OTHER_WS = "55555555-5555-4555-8555-555555555555";

function buildApp(
  opts: { scopes?: string[]; keyWorkspaceId?: string | null } = {}
): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", opts.scopes ?? ["hub-protocol.read"]);
    c.set("userId", USER);
    c.set("agentUserId" as never, "agent-1" as never);
    if (opts.keyWorkspaceId) {
      c.set("keyType" as never, "service" as never);
      c.set("keyWorkspaceId" as never, opts.keyWorkspaceId as never);
    }
    await next();
  });
  registerSurfacesRoutes(app);
  return app;
}

const ANSWER = {
  rows: [
    {
      id: "view-1",
      body: "view",
      relation: "pinned",
      anchor: { kind: "project", id: PROJECT },
      title: "Board",
      openUrl: "/open/view-1",
      readOnly: false,
      source: "views",
    },
  ],
  unavailable: [{ source: "sites", error: "boom" }],
};

beforeEach(() => {
  surfacesForObject.mockReset();
  surfacesForObject.mockResolvedValue(ANSWER);
});

describe("GET /surfaces", () => {
  it("answers the rows AND the stores that could not be read", async () => {
    const res = await buildApp().request(
      `/surfaces?kind=project&id=${PROJECT}&workspaceId=${WS}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ANSWER);
    const [ctx, input] = surfacesForObject.mock.calls[0]!;
    expect(input).toEqual({ kind: "project", id: PROJECT, workspaceId: WS });
    expect(ctx.userId).toBe(USER);
    expect(ctx.access.agentUserId).toBe("agent-1");
  });

  it("refuses a key without hub-protocol.read before reading anything", async () => {
    const res = await buildApp({ scopes: ["hub-protocol.write"] }).request(
      `/surfaces?kind=project&id=${PROJECT}`
    );
    expect(res.status).toBe(403);
    expect(surfacesForObject).not.toHaveBeenCalled();
  });

  it("pins a space-bound key to its space, and refuses another space", async () => {
    const pinned = await buildApp({ keyWorkspaceId: WS }).request(
      `/surfaces?kind=project&id=${PROJECT}`
    );
    expect(pinned.status).toBe(200);
    expect(surfacesForObject.mock.calls[0]![1].workspaceId).toBe(WS);

    surfacesForObject.mockClear();
    const other = await buildApp({ keyWorkspaceId: WS }).request(
      `/surfaces?kind=project&id=${PROJECT}&workspaceId=${OTHER_WS}`
    );
    expect(other.status).toBe(403);
    expect(surfacesForObject).not.toHaveBeenCalled();
  });

  it("400 on an unknown kind; 404 on an anchor you cannot see", async () => {
    const bad = await buildApp().request(`/surfaces?kind=planet&id=${PROJECT}`);
    expect(bad.status).toBe(400);

    surfacesForObject.mockRejectedValue(
      new TRPCError({
        code: "NOT_FOUND",
        message: "No project that you can see.",
      })
    );
    const missing = await buildApp().request(
      `/surfaces?kind=project&id=${PROJECT}`
    );
    expect(missing.status).toBe(404);
  });
});
