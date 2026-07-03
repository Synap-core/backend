/**
 * Hub Protocol REST — playbooks (session → playbook promotion)
 *
 * Thin REST seam over the governed `playbooks.promote` hub sub-router so IS /
 * CLI / MCP share ONE governed path. The write is gated on the loaded session's
 * workspace and `checkPermissionOrPropose` — agent callers get
 * `status: 'proposed'`, operators get `status: 'promoted'`.
 */

import { TRPCError } from "@trpc/server";

import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerPlaybooksRoutes(app: HubHono): void {
  /**
   * POST /playbooks/promote-from-session
   * Body: { sessionId }
   */
  app.post("/playbooks/promote-from-session", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      sessionId?: string;
      name?: string;
      description?: string;
      reasoning?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      const userId = c.get("userId") as string;
      const agentUserId = c.get("agentUserId") as string | undefined;
      const caller = await getCaller(c);
      const result = await caller.playbooks.promote({
        userId,
        sessionId: body.sessionId,
        name: body.name,
        description: body.description,
        agentUserId,
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "playbooks.promote failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });
}
