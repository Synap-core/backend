/**
 * Hub REST `GET /focus-sessions/graph` — a workspace-bound key is confined.
 *
 * The graph needs neither lens (a pod-wide graph is the point), so a key bound
 * to workspace W that named no `workspaceId` read the owner's POD-WIDE graph,
 * full nodes included, and a key naming another workspace was served it
 * (rv-be-loop M3). Now the door runs the one clamp (`getConfinedWorkspace`):
 *  - bound to W, no `workspaceId` ⇒ the window's lens is W, and the far ends
 *    are kept in W (`boundWorkspaceId`);
 *  - bound to W, `workspaceId` = another ⇒ 403, the graph is never built;
 *  - an unbound key ⇒ unchanged: no lens, no far-end clamp.
 *
 * DB-free: `buildWorkGraph` is stubbed to record its input (its own WHERE and
 * the far-end clamp run for real in `work-graph.pglite.test.ts`), and the
 * workspace membership read answers "member".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("../../../services/focus-sessions/work-graph.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    buildWorkGraph: async (input: unknown) => {
      h.inputs.push(input);
      return { nodes: [], edges: [], sections: {}, window: {} };
    },
  };
});
vi.mock("@synap/database", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "editor" }),
  };
});

import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const W = "11111111-1111-4111-8111-111111111111";
const OTHER_W = "22222222-2222-4222-8222-222222222222";

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

const scopeOf = (i: unknown) =>
  (i as { scope: { workspaceLens?: string } }).scope.workspaceLens;
const boundOf = (i: unknown) =>
  (i as { boundWorkspaceId?: string }).boundWorkspaceId;

describe("Hub REST GET /focus-sessions/graph — a workspace-bound key", () => {
  beforeEach(() => {
    h.inputs = [];
  });

  it("bound to W and naming no workspace ⇒ reads W, far ends kept in W", async () => {
    const res = await buildTestApp(W).request(`/focus-sessions/graph`);
    expect(res.status).toBe(200);
    expect(h.inputs).toHaveLength(1);
    expect(scopeOf(h.inputs[0])).toBe(W);
    expect(boundOf(h.inputs[0])).toBe(W);
  });

  it("bound to W and naming another workspace ⇒ 403, no graph built", async () => {
    const res = await buildTestApp(W).request(
      `/focus-sessions/graph?workspaceId=${OTHER_W}`
    );
    expect(res.status).toBe(403);
    expect(h.inputs).toEqual([]);
  });

  it("an unbound key is unchanged: pod-wide window, far ends unclamped", async () => {
    const res = await buildTestApp(null).request(`/focus-sessions/graph`);
    expect(res.status).toBe(200);
    expect(scopeOf(h.inputs[0])).toBeUndefined();
    expect(boundOf(h.inputs[0])).toBeUndefined();
  });
});
