/**
 * Hub Protocol REST — playbooks (session → playbook promotion, definition update)
 *
 * Thin REST seam over the governed `playbooks.promote` / `playbooks.update` hub
 * sub-router mutations so IS / CLI / MCP share ONE governed path. Every write is
 * gated on the loaded row's workspace and `checkPermissionOrPropose` — agent
 * callers get `status: 'proposed'`, operators get the executed result.
 */

import { TRPCError } from "@trpc/server";

import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerPlaybooksRoutes(app: HubHono): void {
  /**
   * PATCH /playbooks/:id
   * Body: { agentUserId?, source?, reasoning?, name?, description?, goalTemplate?,
   *         params?, inputStrategy?, channelSpec?, expectedOutputs?, stages?,
   *         subjectProfile?, schedule?, executor?, status? }
   *
   * Governed mirror of `playbooks.update` (WORKFLOW-AS-PLACE, D4) — the door the
   * analyzer persona uses to submit an evidence-backed definition diff. Never
   * auto-applied for an agent caller: `checkPermissionOrPropose` decides
   * approve-vs-propose from the LOADED playbook's workspace, exactly as the
   * in-app editor's save path does.
   */
  app.patch("/playbooks/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    try {
      const agentUserId =
        (body.agentUserId as string | undefined) ??
        (c.get("agentUserId") as string | undefined);
      const caller = await getCaller(c);
      const result = await caller.playbooks.update({
        id: c.req.param("id"),
        agentUserId,
        source: body.source as string | undefined,
        reasoning: body.reasoning as string | undefined,
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        goalTemplate: body.goalTemplate as string | undefined,
        params: body.params as Record<string, unknown>[] | undefined,
        inputStrategy: body.inputStrategy as
          | Record<string, unknown>
          | undefined,
        channelSpec: body.channelSpec as Record<string, unknown> | undefined,
        expectedOutputs: body.expectedOutputs as
          | Record<string, unknown>[]
          | undefined,
        stages: body.stages as Record<string, unknown>[] | undefined,
        subjectProfile: body.subjectProfile as
          | Record<string, unknown>
          | undefined,
        schedule: body.schedule as string | number | boolean | null | undefined,
        executor: body.executor as
          | "is-agent"
          | "external-agent"
          | "hybrid"
          | undefined,
        status: body.status as
          | "draft"
          | "active"
          | "paused"
          | "archived"
          | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "playbooks.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });

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
      sourceMessageId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      const userId = c.get("userId") as string;
      const agentUserId = c.get("agentUserId") as string | undefined;
      const caller = await getCaller(c, {
        sourceMessageId: body.sourceMessageId,
      });
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
