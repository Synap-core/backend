/**
 * Hub REST GET /entities `scope` — driven through the REAL route with only the
 * tRPC caller and the workspace-access reads stubbed. `scope=pod` used to be
 * accepted, documented ("pod-wide entities only") and ignored: it answered
 * with workspace rows too. What `globalOnly` selects is the regular list's
 * floor (`entityLensWhere(userId, null)`), proven elsewhere; this proves the
 * door asks for it, and refuses what it cannot honour.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const WS = "0bbbbbbb-0000-4000-8000-000000000002";
const PROJECT = "0ccccccc-0000-4000-8000-000000000003";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: { query: {} } };
});

const getEntities = vi.fn(
  async (_input: Record<string, unknown>) => [] as unknown[]
);
const search = vi.fn(async () => ({ results: [] }));
const getCaller = vi.fn(async () => ({
  entities: { getEntities },
  search: { search },
}));
const accessible = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    getCaller: (...a: unknown[]) => getCaller(...(a as [])),
    verifyWorkspaceReadAccess: async () => true,
    getUserAccessibleWorkspaceIds: async () => accessible.ids,
  };
});

const { registerEntitiesRoutes } = await import("./entities.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, USER as never);
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    await next();
  });
  registerEntitiesRoutes(app as never);
  return app;
}

beforeEach(() => {
  getEntities.mockClear();
  search.mockClear();
  accessible.ids = [WS];
});

describe("GET /entities?scope=pod", () => {
  it("asks the list for pod-wide rows only", async () => {
    const res = await makeApp().request(
      "/entities?scope=pod&profileSlug=decision&limit=50&offset=100"
    );
    expect(res.status).toBe(200);
    expect(getEntities).toHaveBeenCalledTimes(1);
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      globalOnly: true,
      profileSlug: "decision",
      limit: 50,
      offset: 100,
    });
  });

  it("still answers for a caller who is in no workspace", async () => {
    accessible.ids = [];
    const res = await makeApp().request("/entities?scope=pod");
    expect(res.status).toBe(200);
    expect(getEntities).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["workspaceId", `/entities?scope=pod&workspaceId=${WS}`],
    ["projectId", `/entities?scope=pod&projectId=${PROJECT}`],
    ["q", "/entities?scope=pod&q=launch"],
  ])("with %s ⇒ 400, nothing listed or searched", async (_name, url) => {
    const res = await makeApp().request(url);
    expect(res.status).toBe(400);
    expect(getEntities).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("no scope ⇒ no globalOnly (never a silent narrow)", async () => {
    await makeApp().request("/entities");
    expect(getEntities.mock.calls[0]![0]).not.toHaveProperty("globalOnly");
  });
});

describe("GET /entities?scope=workspace", () => {
  it("is that workspace's rows only (no pod-wide globals)", async () => {
    const res = await makeApp().request(
      `/entities?scope=workspace&workspaceId=${WS}`
    );
    expect(res.status).toBe(200);
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      includePodWide: false,
    });
  });

  it("without workspaceId ⇒ 400", async () => {
    const res = await makeApp().request("/entities?scope=workspace");
    expect(res.status).toBe(400);
    expect(getEntities).not.toHaveBeenCalled();
  });
});
