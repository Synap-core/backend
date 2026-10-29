/**
 * Hub REST `GET /focus-sessions` — paging and pod-wide scope.
 *
 * `offset` was ignored (page 2 was unreachable) and a read naming neither
 * `workspaceId` nor `projectId` was a 400, though MCP `synap_list_sessions`
 * answers it pod-wide under the owner floor. DB-free: `db.select` is a chain
 * stub recording what the handler asked of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const h = vi.hoisted(() => ({
  offsets: [] as number[],
  orderByArity: [] as number[],
  limits: [] as number[],
}));

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    c.set("keyType", "service");
    c.set("keyWorkspaceId", null);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub REST GET /focus-sessions — offset and pod-wide", () => {
  let selectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h.offsets = [];
    h.orderByArity = [];
    h.limits = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: (...cols: unknown[]) => {
        h.orderByArity.push(cols.length);
        return chain;
      },
      limit: (n: number) => {
        h.limits.push(n);
        return chain;
      },
      offset: async (n: number) => {
        h.offsets.push(n);
        return [];
      },
    };
    selectSpy = vi.spyOn(db, "select").mockReturnValue(chain as never);
  });
  afterEach(() => selectSpy.mockRestore());

  it("forwards offset to the query, newest first with an id tie-break", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?limit=5&offset=10`
    );
    expect(res.status).toBe(200);
    expect(h.offsets).toEqual([10]);
    expect(h.limits).toEqual([5]);
    expect(h.orderByArity).toEqual([2]);
  });

  it("defaults offset to 0 and treats junk as 0", async () => {
    await buildTestApp().request(`/focus-sessions`);
    await buildTestApp().request(`/focus-sessions?offset=abc`);
    await buildTestApp().request(`/focus-sessions?offset=-4`);
    expect(h.offsets).toEqual([0, 0, 0]);
  });

  it("with neither workspaceId nor projectId it lists pod-wide, not 400", async () => {
    const res = await buildTestApp().request(`/focus-sessions`);
    expect(res.status).toBe(200);
    expect(h.offsets).toHaveLength(1);
  });
});
