/**
 * Hub REST `GET /focus-sessions` — a workspace-bound key is confined.
 *
 * The list passed the raw `workspaceId` query as its lens, so a key bound to
 * workspace W read any workspace it named that its owner belongs to, and a
 * project lens alone read the project's sessions in every space. Pod apps and
 * space-package frames run on bound keys. Now the door runs the one clamp
 * (`confineWorkspaceOrForbidden`, as `GET /focus-sessions/graph` does):
 *  - bound to W, no `workspaceId` ⇒ the lens is W (a project lens ANDs with
 *    it), never "workspaceId or projectId is required";
 *  - bound to W, `workspaceId` = another ⇒ 403, no list query;
 *  - an unbound key ⇒ unchanged.
 *
 * DB-free: the membership read answers "member", `db.select` is a chain
 * stub, and `sessionListConditions` is wrapped (real implementation) so the
 * assertion is the lens it RECEIVED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({ scopes: [] as unknown[] }));

vi.mock("@synap/database", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "editor" }),
  };
});
vi.mock("../../../services/projects/load-visible-project.js", () => ({
  loadVisibleProject: vi.fn(async (_db: unknown, id: string) => ({
    id,
    name: "p",
    workspaceId: null,
    userId: "user-1",
  })),
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

const W = "11111111-1111-4111-8111-111111111111";
const OTHER_W = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

function buildTestApp(keyWorkspaceId: string | null): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    c.set("keyType", "service");
    c.set("keyWorkspaceId", keyWorkspaceId);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub REST GET /focus-sessions — a workspace-bound key", () => {
  let selectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
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

  it("bound to W and naming no workspace ⇒ lists W, a project lens ANDs with it", async () => {
    expect((await buildTestApp(W).request(`/focus-sessions`)).status).toBe(200);
    expect(
      (await buildTestApp(W).request(`/focus-sessions?projectId=${PROJECT}`))
        .status
    ).toBe(200);
    expect(h.scopes).toEqual([
      { workspaceLens: W, projectLens: undefined },
      { workspaceLens: W, projectLens: PROJECT },
    ]);
  });

  it("bound to W and naming another workspace ⇒ 403, no list query", async () => {
    const res = await buildTestApp(W).request(
      `/focus-sessions?workspaceId=${OTHER_W}`
    );
    expect(res.status).toBe(403);
    expect(h.scopes).toEqual([]);
  });

  it("an unbound key is unchanged: a project lens alone, no workspace", async () => {
    const res = await buildTestApp(null).request(
      `/focus-sessions?projectId=${PROJECT}`
    );
    expect(res.status).toBe(200);
    expect(h.scopes).toEqual([
      { workspaceLens: undefined, projectLens: PROJECT },
    ]);
  });
});
