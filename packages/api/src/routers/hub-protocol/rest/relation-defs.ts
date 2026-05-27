/**
 * Hub Protocol REST — relation definitions
 */

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
      const result = await caller.relationDefs.list();
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
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.relationDefs.create({
        slug: body.slug as string,
        displayName: body.displayName as string,
        description: body.description as string | undefined,
        isDirectional: body.isDirectional as boolean | undefined,
        uiHints: body.uiHints as Record<string, unknown> | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "relationDefs.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
