/**
 * Hub Protocol REST — GET /designs/kit (plan 0fc746f4 W6): one code file of
 * an app's kit, for the Design app to load through its Hub proxy. Static,
 * so registered before `/designs/:id` (a kit read never reaches design.read);
 * the file comes back as JSON text, never as served code; bytes that are not
 * the pinned ones are
 * a REFUSAL with a code (422 `DESIGN_KIT_BYTES_MISMATCH`), never the bytes.
 * The kit read itself (read floors, hash check) is app-kit.test.ts's.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  part: null as null | (() => unknown),
  partCalls: [] as Array<{ appId: string; part: string }>,
  readCalls: [] as string[],
}));

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  errCode: (err: unknown) => (err instanceof TRPCError ? err.code : undefined),
  httpStatusForTrpcError: (err: unknown) =>
    err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500,
  resolveActingContext: async (c: { get: (k: string) => unknown }) => ({
    ok: true as const,
    userId: c.get("userId") as string,
    workspaceId: null,
    role: "owner",
  }),
}));

vi.mock("../../../services/designs/app-kit.js", async (orig) => ({
  ...(await orig<typeof import("../../../services/designs/app-kit.js")>()),
  readKitPart: async (_userId: string, appId: string, part: string) => {
    h.partCalls.push({ appId, part });
    return h.part!();
  },
}));
vi.mock("../../../services/designs/design-door.js", () => ({
  applyDesign: async () => ({}),
  designCatalog: async () => ({}),
  readDesign: async (_ctx: unknown, id: string) => {
    h.readCalls.push(id);
    return {};
  },
}));

import { KitBytesMismatchError } from "../../../services/designs/app-kit.js";
import { registerDesignsRoutes } from "./designs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";

function buildApp(scopes = ["hub-protocol.read"]): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", scopes);
    c.set("userId", USER);
    await next();
  });
  registerDesignsRoutes(app);
  return app;
}

beforeEach(() => {
  h.partCalls.length = 0;
  h.readCalls.length = 0;
  h.part = () => ({
    kitId: "crm",
    hash: "sha256:kit",
    part: "js",
    sha256: "a".repeat(64),
    bytes: Buffer.from("export const components = {};"),
  });
});

describe("GET /designs/kit", () => {
  it("answers the pinned file as JSON text (never served code), and never reaches GET /designs/:id", async () => {
    const res = await buildApp().request(`/designs/kit?appId=${APP}&part=js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({
      kitId: "crm",
      hash: "sha256:kit",
      part: "js",
      sha256: "a".repeat(64),
      bytes: 29,
      content: "export const components = {};",
    });
    expect(h.partCalls).toEqual([{ appId: APP, part: "js" }]);
    expect(h.readCalls).toEqual([]);
  });

  it("bytes that are not the pinned ones: a 422 with its code, never the bytes", async () => {
    h.part = () => {
      throw new KitBytesMismatchError(
        "App x's kit js (file y) is not the one its catalog pins."
      );
    };
    const res = await buildApp().request(`/designs/kit?appId=${APP}&part=js`);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "DESIGN_KIT_BYTES_MISMATCH",
      error: expect.stringMatching(/not the one its catalog pins/),
    });
  });

  it("an app with no kit is a 404; a bad part or app id a 400; no read scope a 403", async () => {
    h.part = () => {
      throw new TRPCError({ code: "NOT_FOUND", message: "no design kit" });
    };
    expect(
      (await buildApp().request(`/designs/kit?appId=${APP}&part=js`)).status
    ).toBe(404);
    expect(
      (await buildApp().request(`/designs/kit?appId=${APP}&part=html`)).status
    ).toBe(400);
    expect(
      (await buildApp().request(`/designs/kit?appId=nope&part=js`)).status
    ).toBe(400);
    expect(
      (await buildApp([]).request(`/designs/kit?appId=${APP}&part=js`)).status
    ).toBe(403);
  });
});
