/**
 * Hub Protocol REST — GET /brand/kit
 *
 * Pins the wire contract (C2, lens model): 200 = the kit + the resolution
 * (`brandWorkspaceId`, `brandIdentityId`, `projectId`, `resolvedVia`), a TYPED
 * 404 with `reason` + human `message` for each absence, and a 5xx — never an
 * empty kit, never a 404 — when a read fails. The kit is exported by the REAL
 * `exportResolvedBrandKit` from exactly the rows the resolver chose.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolution: null as unknown,
  resolveThrows: null as Error | null,
  kitSource: [] as Array<Record<string, unknown>>,
  resolveCalls: [] as Array<Record<string, unknown>>,
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

vi.mock("../../../services/brand/brand-kit-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/brand/brand-kit-service.js")
  >()),
  resolveBrand: async (args: Record<string, unknown>) => {
    h.resolveCalls.push(args);
    if (h.resolveThrows) throw h.resolveThrows;
    return { resolution: h.resolution, kitSource: h.kitSource };
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

const IDENTITY = "66666666-6666-4666-8666-666666666666";
const S_COLOR = {
  profileSlug: "brand-color",
  title: "Ochre",
  properties: { "color-role": "primary", "color-hex": "#B67A38" },
};

beforeEach(() => {
  h.resolution = {
    ok: true,
    brandWorkspaceId: LIB,
    brandIdentityId: IDENTITY,
    projectId: PROJECT,
    resolvedVia: "project",
  };
  h.kitSource = [S_COLOR];
  h.resolveThrows = null;
  h.resolveCalls.length = 0;
});

describe("GET /brand/kit", () => {
  it("returns the chosen brand's kit with its resolution, threading project + workspace", async () => {
    const res = await buildApp().request(
      `/brand/kit?format=css&projectId=${PROJECT}&workspaceId=${WS}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      format: "css",
      brandWorkspaceId: LIB,
      brandIdentityId: IDENTITY,
      projectId: PROJECT,
      resolvedVia: "project",
    });
    expect(body.ok).toBeUndefined();
    expect(body.content).toContain("--brand-primary: #b67a38;");
    expect(body.hash).toMatch(/^[0-9a-f]{14}$/);
    expect(h.resolveCalls).toEqual([
      { userId: USER, projectId: PROJECT, workspaceId: WS },
    ]);
  });

  it("defaults the format to json", async () => {
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { format: string }).format).toBe("json");
  });

  it.each([
    ["no-brand-space", null],
    ["no-brand-for-project", LIB],
    ["no-default-brand", LIB],
  ] as const)(
    "%s is a TYPED 404 with the human message",
    async (reason, brandWorkspaceId) => {
      h.resolution = {
        ok: false,
        reason,
        message: `msg ${reason}`,
        brandWorkspaceId,
        projectId: null,
      };
      const res = await buildApp().request("/brand/kit");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: `msg ${reason}`,
        reason,
        message: `msg ${reason}`,
        brandWorkspaceId,
        projectId: null,
      });
    }
  );

  it("a failed resolution is a 5xx, never an empty kit or a 404", async () => {
    h.resolveThrows = new Error("db down");
    const res = await buildApp().request("/brand/kit");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content).toBeUndefined();
    expect(body.reason).toBeUndefined();
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
