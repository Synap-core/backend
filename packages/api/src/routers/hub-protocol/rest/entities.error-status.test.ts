/**
 * GET /entities error statuses — driven through the REAL router, with only the
 * tRPC caller and the two workspace-access reads stubbed.
 *
 * Live 2026-09-25 both of these answered 500:
 *   - `?facetSlug=<undeclared role>` — `assertKnownProfileSlug` throws a
 *     deliberate TRPC NOT_FOUND, and the route's catch hard-coded 500.
 *   - `?workspaceId=notauuid` — the value reached a Postgres `uuid` comparison
 *     (22P02) and escaped through the same catch.
 * Fixes: every entities.ts catch maps through `httpStatusForTrpcError`; every
 * `workspaceId` input is `uuidQueryParam`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const WS = "0bbbbbbb-0000-4000-8000-000000000002";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: { query: {} } };
});

// What `createCaller` actually hands the route: the domain NOT_FOUND wrapped
// one level down under INTERNAL_SERVER_ERROR (errorCatchingMiddleware).
const unknownRole = () =>
  new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    cause: new TRPCError({
      code: "NOT_FOUND",
      message: 'Unknown profile: "nope".',
    }),
  });

const getEntities = vi.fn();
const getCaller = vi.fn(async () => ({ entities: { getEntities } }));
const verifyWorkspaceReadAccess = vi.fn(async () => true);
const getUserAccessibleWorkspaceIds = vi.fn(async () => [WS]);

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  // httpStatusForTrpcError stays REAL — it is the thing under test.
  return {
    ...actual,
    getCaller: (...a: unknown[]) => getCaller(...(a as [])),
    verifyWorkspaceReadAccess: (...a: unknown[]) =>
      verifyWorkspaceReadAccess(...(a as [])),
    getUserAccessibleWorkspaceIds: (...a: unknown[]) =>
      getUserAccessibleWorkspaceIds(...(a as [])),
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

describe("entities.ts — no catch hard-codes a 500 (the CLASS, file-scoped)", () => {
  // Behaviour is proven above for GET /entities only; this holds the other
  // catch sites in this file. Granularity: the catch BODY — it cannot tell a
  // deliberate 500 from a lazy one, so a legit one needs its own mapper.
  it("every catch body maps its status instead of a literal 500", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "entities.ts"), "utf8");
    const bodies: string[] = [];
    for (const m of src.matchAll(/catch \((?:err|e|error|relErr)\) \{/g)) {
      let depth = 0;
      const open = src.indexOf("{", m.index!);
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) {
          bodies.push(src.slice(open, i + 1));
          break;
        }
      }
    }
    expect(bodies.length).toBeGreaterThan(10); // non-vacuity (2026-09-25: 17)
    const literal500 = bodies.filter((b) => /,\s*500\s*\)/.test(b));
    expect(literal500).toEqual([]);
  });
});

describe("GET /entities — errors keep their real status", () => {
  beforeEach(() => {
    getEntities.mockReset();
    getCaller.mockClear();
    verifyWorkspaceReadAccess.mockClear();
  });

  it("undeclared facetSlug in a workspace lens → 404 with the actionable message", async () => {
    getEntities.mockRejectedValue(unknownRole());
    const res = await makeApp().request(
      `/entities?facetSlug=nope&workspaceId=${WS}`
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Unknown profile");
  });

  it("undeclared facetSlug with no lens → 404", async () => {
    getEntities.mockRejectedValue(unknownRole());
    const res = await makeApp().request(`/entities?facetSlug=nope`);
    expect(res.status).toBe(404);
  });

  it("undeclared facetSlug with scope=all → 404, never a calm []", async () => {
    getEntities.mockRejectedValue(unknownRole());
    const res = await makeApp().request(`/entities?facetSlug=nope&scope=all`);
    expect(res.status).toBe(404);
  });

  it("a genuinely unknown failure is still a 500", async () => {
    getEntities.mockRejectedValue(new Error("boom"));
    const res = await makeApp().request(`/entities?workspaceId=${WS}`);
    expect(res.status).toBe(500);
  });

  it("non-uuid workspaceId → 400 at the door; nothing downstream runs", async () => {
    const res = await makeApp().request(`/entities?workspaceId=notauuid`);
    expect(res.status).toBe(400);
    expect(verifyWorkspaceReadAccess).not.toHaveBeenCalled();
    expect(getCaller).not.toHaveBeenCalled();
  });

  it("empty workspaceId stays 'absent' (no 400) — callers send ?workspaceId=", async () => {
    getEntities.mockResolvedValue([]);
    const res = await makeApp().request(`/entities?workspaceId=`);
    expect(res.status).toBe(200);
  });
});
