/**
 * Hub REST `GET /focus-sessions` — a PROJECT lens alone is a valid scope (X1).
 *
 * The CLI (`synap session list`) and the IS ride this door. It refused any
 * call without `workspaceId` ("workspaceId is required") although project
 * sessions routinely carry NO workspace and the MCP door already answered a
 * project-only list. Now:
 *  - `projectId` alone ⇒ 200, the project lens reaches `sessionListConditions`;
 *  - a project the caller cannot see (`loadVisibleProject` → undefined) ⇒ 404,
 *    never a calm `[]`;
 *  - neither ⇒ 400 naming both.
 *
 * DB-free: `loadVisibleProject` is mocked (its own predicate is covered where
 * it lives), `db.select` is spied with a chain stub, and
 * `sessionListConditions` is wrapped (real implementation) so the assertion is
 * the lens it RECEIVED, not the status code alone. Cannot see: the SQL the
 * lens compiles to (owned by `session-scope.ts` + its tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  visible: true,
  scopes: [] as unknown[],
}));

vi.mock("../../../services/projects/load-visible-project.js", () => ({
  loadVisibleProject: vi.fn(async (_db: unknown, id: string) =>
    h.visible
      ? { id, name: "p", workspaceId: null, userId: "user-1" }
      : undefined
  ),
}));
vi.mock(
  "../../../services/focus-sessions/session-list-conditions.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/focus-sessions/session-list-conditions.js")
      >();
    return {
      ...actual,
      sessionListConditions: (
        q: Parameters<typeof actual.sessionListConditions>[0]
      ) => {
        h.scopes.push(q.scope);
        return actual.sessionListConditions(q);
      },
    };
  }
);

import { db } from "@synap/database";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub REST GET /focus-sessions — project lens alone", () => {
  let selectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h.visible = true;
    h.scopes = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [],
    };
    selectSpy = vi.spyOn(db, "select").mockReturnValue(chain as never);
  });
  afterEach(() => selectSpy.mockRestore());

  it("projectId alone ⇒ 200 and the project lens reaches the one WHERE builder", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}`
    );
    expect(res.status).toBe(200);
    expect(h.scopes).toEqual([
      { workspaceLens: undefined, projectLens: PROJECT },
    ]);
  });

  it("a project the caller cannot see ⇒ 404, no list query", async () => {
    h.visible = false;
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}`
    );
    expect(res.status).toBe(404);
    expect(h.scopes).toEqual([]);
  });

  it("a malformed projectId ⇒ 400", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=c074e8ac`
    );
    expect(res.status).toBe(400);
  });

  it("neither workspaceId nor projectId ⇒ 400 naming both", async () => {
    const res = await buildTestApp().request(`/focus-sessions`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /workspaceId or projectId/
    );
  });
});
