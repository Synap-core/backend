/**
 * REST view writes must retain the authenticated acting identity rather than
 * forwarding the caller-controlled `userId` / `workspaceId` payload fields.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACTING_USER_ID = "user-authenticated";
const ACTING_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BODY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const arrangeBento = vi.fn();

vi.mock("./_shared.js", () => ({
  getCaller: vi.fn(),
  hasScope: vi.fn(() => true),
  logger: { error: vi.fn() },
  resolveActorId: vi.fn(async (_agentUserId: unknown, userId: string) => ({
    actorId: userId,
  })),
  resolveActingContext: vi.fn(),
  // No service-key confinement in play here — pass the requested workspace
  // through unchanged, mirroring getConfinedWorkspace's legacy-passthrough
  // contract for a non-service key.
  confineWorkspaceOrForbidden: vi.fn((_c: unknown, requested: unknown) => ({
    ok: true,
    workspaceId: requested,
  })),
  httpStatusForTrpcError: (err: unknown) => {
    let cursor: unknown = err;
    for (
      let depth = 0;
      cursor && typeof cursor === "object" && depth < 4;
      depth++
    ) {
      const code = (cursor as { code?: unknown }).code;
      if (code === "BAD_REQUEST") return 400;
      if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return 403;
      if (code === "NOT_FOUND") return 404;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return 500;
  },
}));

import { registerViewsRoutes } from "./views.js";
import { getCaller, resolveActingContext } from "./_shared.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", ACTING_USER_ID);
    c.set("scopes", ["hub-protocol.write"]);
    await next();
  });
  registerViewsRoutes(app);
  return app;
}

describe("POST /views/:viewId/arrange identity binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveActingContext).mockResolvedValue({
      ok: true,
      userId: ACTING_USER_ID,
      workspaceId: ACTING_WORKSPACE_ID,
      role: "editor",
    });
    arrangeBento.mockResolvedValue({ status: "ok" });
    vi.mocked(getCaller).mockResolvedValue({
      views: { arrangeBento },
    } as never);
  });

  it("uses the resolved principal and workspace, never payload impersonation", async () => {
    const response = await buildApp().request("/views/view-1/arrange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "victim-user",
        workspaceId: BODY_WORKSPACE_ID,
        widgets: [{ key: "entity-list", x: 0, y: 0, w: 4, h: 2 }],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveActingContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "victim-user",
        workspaceId: BODY_WORKSPACE_ID,
      })
    );
    expect(getCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: ACTING_USER_ID,
        workspaceId: ACTING_WORKSPACE_ID,
      })
    );
    expect(arrangeBento).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACTING_USER_ID,
        workspaceId: ACTING_WORKSPACE_ID,
      })
    );
  });

  it("maps a compose-catalog BAD_REQUEST onto HTTP 400, not 500", async () => {
    arrangeBento.mockRejectedValue(
      Object.assign(
        new Error(
          'Bento arrange rejected unknown or under-specified widgets:\n- Unknown widget "entity-metric"'
        ),
        { code: "BAD_REQUEST" }
      )
    );
    const response = await buildApp().request("/views/view-1/arrange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: ACTING_USER_ID,
        workspaceId: ACTING_WORKSPACE_ID,
        widgets: [{ key: "entity-metric", x: 0, y: 0, w: 3, h: 3 }],
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/entity-metric/);
  });
});
