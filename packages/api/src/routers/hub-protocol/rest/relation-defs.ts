/**
 * Hub Protocol REST — relation definitions
 */

import { getConfinedWorkspace } from "../confine-workspace.js";

import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerRelationDefsRoutes(app: HubHono): void {
  /**
   * GET /relation-defs?userId=...&workspaceId=...
   */
  app.get("/relation-defs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.query("userId") ?? "";
    const workspaceId = c.req.query("workspaceId") ?? "";
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.relationDefs.list({ userId, workspaceId });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "relationDefs.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /relation-defs
   * Body: { userId, workspaceId, slug, displayName, description?, isDirectional? }
   */
  app.post("/relation-defs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    const userId = (body.userId as string) ?? "";
    const workspaceId = (body.workspaceId as string) ?? "";
    if (!workspaceId || !body.slug || !body.displayName) {
      return c.json(
        { error: "workspaceId, slug, and displayName are required" },
        400
      );
    }
    try {
      // SERVICE-KEY CONFINEMENT (Item 3): inner `relationDefs.create` is a
      // scopedProcedure that reads `input.workspaceId` and rebuilds its OWN
      // (unconfined) caller ctx from it — the getCaller ctx-clamp does not reach
      // it. Positive-pin the value fed to BOTH the caller ctx and the input
      // (mismatching body → 403).
      const confinedWorkspaceId =
        getConfinedWorkspace(c, workspaceId) ?? workspaceId;
      const caller = await getCaller(c, {
        userId,
        workspaceId: confinedWorkspaceId,
      });
      const result = await caller.relationDefs.create({
        userId,
        workspaceId: confinedWorkspaceId,
        slug: body.slug as string,
        displayName: body.displayName as string,
        description: body.description as string | undefined,
        isDirectional: body.isDirectional as boolean | undefined,
        uiHints: body.uiHints as Record<string, unknown> | undefined,
      });
      return c.json(result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: FORBIDDEN → 403, not a blanket 500. Duck-typed
      // on `.code` (bundled-build TRPCError identity defeats instanceof).
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      logger.error({ err }, "relationDefs.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
