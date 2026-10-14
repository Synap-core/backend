/**
 * Hub REST "Not in a project" — GET /entities?withoutProject=true and
 * GET /entities/without-project/counts, driven through the REAL routes with
 * only the tRPC caller and the workspace-access reads stubbed. The SQL itself
 * is proven on PGlite in `routers/entities/without-project.pglite.test.ts`;
 * this proves the REST door hands the flag on (a dropped query param is a 200
 * that answers for every project).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const WS = "0bbbbbbb-0000-4000-8000-000000000002";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: { query: {} } };
});

const getEntities = vi.fn(async () => []);
const countWithoutProject = vi.fn(async () => ({
  total: 3,
  byProfile: [
    { profileSlug: "note", count: 2 },
    { profileSlug: "task", count: 1 },
  ],
}));
const search = vi.fn(async () => ({ results: [] }));
const getCaller = vi.fn(async () => ({
  entities: { getEntities, countWithoutProject },
  search: { search },
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    getCaller: (...a: unknown[]) => getCaller(...(a as [])),
    verifyWorkspaceReadAccess: async () => true,
    getUserAccessibleWorkspaceIds: async () => [WS],
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
  countWithoutProject.mockClear();
  search.mockClear();
});

describe("GET /entities?withoutProject=true", () => {
  it("hands the flag to the one list door", async () => {
    const res = await makeApp().request(
      "/entities?withoutProject=true&profileSlug=note&limit=10&offset=20"
    );
    expect(res.status).toBe(200);
    expect(getEntities).toHaveBeenCalledTimes(1);
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      withoutProject: true,
      profileSlug: "note",
      limit: 10,
      offset: 20,
    });
  });

  it("scope=all hands it to every lens", async () => {
    const res = await makeApp().request(
      "/entities?withoutProject=true&scope=all"
    );
    expect(res.status).toBe(200);
    expect(getEntities.mock.calls[0]![0]).toMatchObject({
      withoutProject: true,
    });
  });

  it("absent or false ⇒ no flag (never a silent narrow)", async () => {
    await makeApp().request("/entities");
    await makeApp().request("/entities?withoutProject=false");
    for (const call of getEntities.mock.calls) {
      expect(call[0]).not.toHaveProperty("withoutProject");
    }
  });

  it("with q ⇒ 400 (search applies no project lens), search never runs", async () => {
    const res = await makeApp().request("/entities?withoutProject=true&q=x");
    expect(res.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
});

describe("GET /entities/without-project/counts", () => {
  it("returns the counts of the caller's own floor", async () => {
    const res = await makeApp().request("/entities/without-project/counts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: 3,
      byProfile: [
        { profileSlug: "note", count: 2 },
        { profileSlug: "task", count: 1 },
      ],
    });
    expect(countWithoutProject).toHaveBeenCalledWith({ userId: USER });
  });

  it("a failed count is an error status, never a calm zero", async () => {
    countWithoutProject.mockRejectedValueOnce(new Error("boom"));
    const res = await makeApp().request("/entities/without-project/counts");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
