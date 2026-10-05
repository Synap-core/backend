/**
 * Hub Protocol REST — GET /brand/kit
 *
 * Pins the wire contract (C2): 200 shape with brandWorkspaceId + resolvedVia,
 * a TYPED 404 for "no brand", and a 5xx — never an empty kit — when a read
 * fails.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolution: null as unknown,
  resolveThrows: null as Error | null,
  readThrows: null as Error | null,
  resolveCalls: [] as Array<Record<string, unknown>>,
  readCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  httpStatusForTrpcError: () => 500,
  resolveActingContext: async (c: { get: (k: string) => unknown }) => ({
    ok: true as const,
    userId: c.get("userId") as string,
    workspaceId: null,
    role: "owner",
  }),
}));

vi.mock("../../../services/brand/brand-kit-service.js", () => ({
  resolveBrandWorkspace: async (args: Record<string, unknown>) => {
    h.resolveCalls.push(args);
    if (h.resolveThrows) throw h.resolveThrows;
    return h.resolution;
  },
  readBrandKit: async (args: Record<string, unknown>) => {
    h.readCalls.push(args);
    if (h.readThrows) throw h.readThrows;
    return {
      format: args.format,
      content: ":root {\n}\n",
      hash: "00000000000abc",
    };
  },
}));

import { registerBrandRoutes } from "./brand.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const LIB = "55555555-5555-4555-8555-555555555555";

function buildApp(scopes = ["hub-protocol.read"]): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", scopes);
    c.set("userId", USER);
    await next();
  });
  registerBrandRoutes(app);
  return app;
}

beforeEach(() => {
  h.resolution = { ok: true, brandWorkspaceId: LIB, resolvedVia: "project" };
  h.resolveThrows = null;
  h.readThrows = null;
  h.resolveCalls.length = 0;
  h.readCalls.length = 0;
});

describe("GET /brand/kit", () => {
  it("returns the kit with its resolution, threading project + workspace", async () => {
    const res = await buildApp().request(
      `/brand/kit?format=css&projectId=${PROJECT}&workspaceId=${WS}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      format: "css",
      content: ":root {\n}\n",
      hash: "00000000000abc",
      brandWorkspaceId: LIB,
      resolvedVia: "project",
    });
    expect(h.resolveCalls).toEqual([
      { userId: USER, projectId: PROJECT, workspaceId: WS },
    ]);
    expect(h.readCalls).toEqual([
      { userId: USER, brandWorkspaceId: LIB, format: "css" },
    ]);
  });

  it("defaults the format to json", async () => {
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(200);
    expect(h.readCalls[0]!.format).toBe("json");
  });

  it("no brand is a TYPED 404 and reads nothing", async () => {
    h.resolution = { ok: false, reason: "no_brand_workspace" };
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no_brand_workspace"
    );
    expect(h.readCalls).toHaveLength(0);
  });

  it("an invisible project is a typed project_not_found 404", async () => {
    h.resolution = { ok: false, reason: "project_not_found" };
    const res = await buildApp().request(`/brand/kit?projectId=${PROJECT}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "project_not_found"
    );
  });

  it("a failed resolution is a 5xx, never an empty kit or a 404", async () => {
    h.resolveThrows = new Error("db down");
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content).toBeUndefined();
    expect(body.reason).toBeUndefined();
  });

  it("a failed kit read is a 5xx", async () => {
    h.readThrows = new Error("timeout");
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(500);
  });

  it("rejects an unknown format and a malformed id with 400", async () => {
    expect((await buildApp().request("/brand/kit?format=pdf")).status).toBe(
      400
    );
    expect((await buildApp().request("/brand/kit?projectId=nope")).status).toBe(
      400
    );
  });

  it("requires the read scope", async () => {
    expect((await buildApp([]).request("/brand/kit")).status).toBe(403);
  });
});
