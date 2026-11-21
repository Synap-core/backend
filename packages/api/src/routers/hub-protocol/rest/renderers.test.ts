/**
 * `GET /api/hub/renderers/host-modules` — the REST mirror of
 * `renderers.hostModules` (spec c9b1e4d0 §3c):
 *   - 200 with `ETag: "sha256:<set>"` and `Cache-Control: private, no-cache`;
 *   - 304 (same headers, no body, the modules never read) when If-None-Match
 *     names that ETag, weak or in a list; a stale tag gets 200;
 *   - 404 `NO_RENDERER_BUNDLE` with no bundle;
 *   - 403 without `hub-protocol.read`.
 * The read service is a stand-in: its rows are covered on PGlite
 * (`services/renderers/install-renderer-bundle.pglite.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const SET = "d".repeat(64);
const h = vi.hoisted(() => ({
  set: null as string | null,
  modulesRead: 0,
}));

vi.mock("../../../services/renderers/read-renderer-bundle.js", () => ({
  NO_RENDERER_BUNDLE: "NO_RENDERER_BUNDLE",
  readRendererSetSha256: async () => h.set,
  readRendererHostModules: async () => {
    h.modulesRead += 1;
    return {
      notModified: false,
      setSha256: h.set,
      modules: { react: "export default {}" },
      kitExports: ["Card"],
    };
  },
}));

const { registerRenderersRoutes } = await import("./renderers.js");

function buildApp(scopes: string[]) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, scopes as never);
    c.set("userId" as never, "user-1" as never);
    await next();
  });
  registerRenderersRoutes(app as never);
  return app;
}
const app = buildApp(["hub-protocol.read"]);
const get = (headers: Record<string, string> = {}) =>
  app.request("/renderers/host-modules", { headers });

beforeEach(() => {
  h.set = SET;
  h.modulesRead = 0;
});

describe("GET /renderers/host-modules", () => {
  it("200: the set, with its ETag and no-cache", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"sha256:${SET}"`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(await res.json()).toEqual({
      setSha256: SET,
      modules: { react: "export default {}" },
      kitExports: ["Card"],
    });
  });

  it("304 when If-None-Match names the current set, without reading the modules", async () => {
    for (const tag of [
      `"sha256:${SET}"`,
      `W/"sha256:${SET}"`,
      `"sha256:${"0".repeat(64)}", "sha256:${SET}"`,
    ]) {
      const res = await get({ "If-None-Match": tag });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"sha256:${SET}"`);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      expect(await res.text()).toBe("");
    }
    expect(h.modulesRead).toBe(0);
  });

  it("200 for a stale tag", async () => {
    const res = await get({ "If-None-Match": `"sha256:${"0".repeat(64)}"` });
    expect(res.status).toBe(200);
    expect(h.modulesRead).toBe(1);
  });

  it("404 NO_RENDERER_BUNDLE when none is installed", async () => {
    h.set = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NO_RENDERER_BUNDLE" });
  });

  it("403 without hub-protocol.read", async () => {
    const res = await buildApp(["mcp.read"]).request("/renderers/host-modules");
    expect(res.status).toBe(403);
  });
});
