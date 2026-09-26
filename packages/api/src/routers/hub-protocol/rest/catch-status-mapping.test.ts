/**
 * Catch-all 500 class — behaviour, through the REAL routers.
 *
 * Before 2026-09-25 two thirds of the Hub route files answered every caught
 * error with a literal 500. They now route the catch through the shared
 * `httpStatusForTrpcError`. This drives one plain Hono handler
 * (`GET /relation-defs`) and one typed `app.openapi` route (`GET /knowledge`)
 * with a thrown domain error and asserts the real status arrives — and that a
 * genuinely unknown error still answers 500. The class across every file is
 * held by `__tripwires__/hub-rest-catch-maps-status.test.ts`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const WS = "0bbbbbbb-0000-4000-8000-000000000002";

const knowledgeList = vi.fn();
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: {} },
    knowledgeKeysRepository: { list: (...a: unknown[]) => knowledgeList(...a) },
  };
});

// What `createCaller` hands a route: the domain code wrapped one level down.
const wrapped = (code: TRPCError["code"], message: string) =>
  new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    cause: new TRPCError({ code, message }),
  });

const relationDefsList = vi.fn();
vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  // httpStatusForTrpcError stays REAL — it is the thing under test.
  return {
    ...actual,
    getCaller: async () => ({ relationDefs: { list: relationDefsList } }),
    getUserAccessibleWorkspaceIds: async () => [WS],
  };
});

const { registerRelationDefsRoutes } = await import("./relation-defs.js");
const { registerKnowledgeRoutes } = await import("./knowledge.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, USER as never);
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    await next();
  });
  registerRelationDefsRoutes(app as never);
  registerKnowledgeRoutes(app as never);
  return app;
}

describe("plain handler catch — GET /relation-defs", () => {
  beforeEach(() => {
    relationDefsList.mockReset();
  });

  it("a wrapped FORBIDDEN answers 403, not 500", async () => {
    relationDefsList.mockImplementation(async () => {
      throw wrapped("FORBIDDEN", "not yours");
    });
    const res = await makeApp().request(
      `/relation-defs?userId=${USER}&workspaceId=${WS}`
    );
    expect(res.status).toBe(403);
  });

  it("a genuinely unknown error still answers 500", async () => {
    relationDefsList.mockImplementation(async () => {
      throw new Error("db down");
    });
    const res = await makeApp().request(
      `/relation-defs?userId=${USER}&workspaceId=${WS}`
    );
    expect(res.status).toBe(500);
  });
});

describe("typed openapi route catch — GET /knowledge", () => {
  beforeEach(() => {
    knowledgeList.mockReset();
  });

  it("a NOT_FOUND answers 404 with the actionable message", async () => {
    knowledgeList.mockImplementation(async () => {
      throw wrapped("NOT_FOUND", "No such namespace");
    });
    const res = await makeApp().request(`/knowledge?workspaceId=${WS}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  it("a CONFLICT answers 409", async () => {
    knowledgeList.mockImplementation(async () => {
      throw new TRPCError({ code: "CONFLICT" });
    });
    const res = await makeApp().request(`/knowledge?workspaceId=${WS}`);
    expect(res.status).toBe(409);
  });

  it("a genuinely unknown error still answers 500", async () => {
    knowledgeList.mockImplementation(async () => {
      throw new Error("boom");
    });
    const res = await makeApp().request(`/knowledge?workspaceId=${WS}`);
    expect(res.status).toBe(500);
  });
});
