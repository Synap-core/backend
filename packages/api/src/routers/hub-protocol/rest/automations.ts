/**
 * Hub Protocol REST — automations
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  AutomationLifecycleRequestSchema,
  CreateAutomationRequestSchema,
  ListAutomationsQuerySchema,
  TriggerAutomationRequestSchema,
  UpdateAutomationRequestSchema,
  WireAutomationSchema,
} from "./_codecs/automation.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";
import { AUTOMATION_SCHEMA } from "./automation-schema-doc.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { TRPCError } from "@trpc/server";

export function registerAutomationsRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /automations* routes ────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/automations/create",
    tags: ["Automations"],
    summary: "Create an automation",
    description:
      "Creates an automation. Defaults to status=draft. Use POST /automations/{id}/activate to enable it.",
    request: {
      body: CreateAutomationRequestSchema,
    },
    responses: {
      200: { description: "Created automation", schema: WireAutomationSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/automations",
    tags: ["Automations"],
    summary: "List automations",
    description:
      "Returns automations for the user, optionally filtered by status.",
    request: {
      query: ListAutomationsQuerySchema,
    },
    responses: {
      200: {
        description: "Array of automations",
        schema: z.array(WireAutomationSchema),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/automations/{automationId}",
    tags: ["Automations"],
    summary: "Get an automation",
    request: {
      params: z.object({ automationId: z.string() }),
      query: z.object({
        userId: z.string(),
        workspaceId: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Automation", schema: WireAutomationSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Automation not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/automations/{automationId}/trigger",
    tags: ["Automations"],
    summary: "Manually trigger an automation",
    description:
      "Runs the automation flow once with an optional payload. Bypasses the automation's normal trigger config.",
    request: {
      params: z.object({ automationId: z.string() }),
      body: TriggerAutomationRequestSchema,
    },
    responses: {
      200: {
        description: "Trigger result (run id, status, optional output)",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Automation not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/automations/{automationId}",
    tags: ["Automations"],
    summary: "Update an automation",
    request: {
      params: z.object({ automationId: z.string() }),
      body: UpdateAutomationRequestSchema,
    },
    responses: {
      200: { description: "Updated automation", schema: WireAutomationSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/automations/{automationId}/activate",
    tags: ["Automations"],
    summary: "Activate an automation",
    request: {
      params: z.object({ automationId: z.string() }),
      body: AutomationLifecycleRequestSchema,
    },
    responses: {
      200: {
        description: "Activated automation",
        schema: WireAutomationSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/automations/{automationId}/pause",
    tags: ["Automations"],
    summary: "Pause an automation",
    request: {
      params: z.object({ automationId: z.string() }),
      body: AutomationLifecycleRequestSchema,
    },
    responses: {
      200: { description: "Paused automation", schema: WireAutomationSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /automations/create
   */
  app.post("/automations/create", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);

    const userId = (body.userId as string) ?? (c.get("userId") as string);
    // Service-key workspace confinement (Item 3): pin/clamp before the workspace
    // reaches getCaller OR the re-supplied createAutomation input (input wins).
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(
        c,
        (body.workspaceId as string | null | undefined) ?? null
      );
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }
    if (!body.triggerType) {
      return c.json({ error: "triggerType is required" }, 400);
    }

    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId,
        sourceMessageId: (body.sourceMessageId as string) ?? null,
      });
      const result = await caller.automations.createAutomation({
        userId,
        agentUserId: body.agentUserId as string | undefined,
        workspaceId,
        sourceMessageId: body.sourceMessageId as string | undefined,
        name: body.name as string,
        description: body.description as string | undefined,
        triggerType: body.triggerType as
          | "event"
          | "cron"
          | "webhook"
          | "manual",
        triggerConfig: (body.triggerConfig as Record<string, unknown>) ?? {},
        flowDefinition: body.flowDefinition as {
          nodes: Record<string, unknown>[];
          edges: Record<string, unknown>[];
        },
        status: ((body.status as string) ?? "draft") as
          | "draft"
          | "active"
          | "paused"
          | "error",
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /automations?userId=...&workspaceId=...&status=...&limit=...
   */
  app.get("/automations", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId) return c.json({ error: "userId is required" }, 400);

    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId: workspaceId ?? null,
      });
      const result = await caller.automations.listAutomations({
        userId,
        workspaceId: workspaceId ?? null,
        status: (c.req.query("status") || undefined) as
          | "draft"
          | "active"
          | "paused"
          | "error"
          | undefined,
        limit: c.req.query("limit")
          ? parseInt(c.req.query("limit")!, 10)
          : undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /automations/schema
   *
   * Static, agent-readable automation reference document. Registered with the
   * standard hub-protocol.read Bearer scope check so AGENTS can read it — the
   * legacy apps/api mount was cookie-gated (authMiddleware) and 401'd Bearer
   * callers. MUST be declared BEFORE GET /automations/:automationId so Hono's
   * first-match router does not capture "schema" as an automationId.
   */
  app.get("/automations/schema", (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    return c.json(AUTOMATION_SCHEMA);
  });

  /**
   * GET /automations/:automationId
   */
  app.get("/automations/:automationId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId) return c.json({ error: "userId is required" }, 400);

    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId: workspaceId ?? null,
      });
      const result = await caller.automations.getAutomation({
        userId,
        workspaceId: workspaceId ?? null,
        id: c.req.param("automationId"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.get failed");
      const status =
        err instanceof Error && err.message.includes("not found") ? 404 : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        status
      );
    }
  });

  /**
   * POST /automations/:automationId/trigger
   */
  app.post("/automations/:automationId/trigger", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const userId = (body.userId as string) ?? (c.get("userId") as string);
    // Service-key workspace confinement (Item 3): pin/clamp before the workspace
    // reaches getCaller OR the re-supplied triggerAutomation input.
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(
        c,
        (body.workspaceId as string | null | undefined) ?? null
      );
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.automations.triggerAutomation({
        userId,
        workspaceId,
        id: c.req.param("automationId"),
        payload: body.payload as Record<string, unknown> | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.trigger failed");
      const status =
        err instanceof Error && err.message.includes("not found") ? 404 : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        status
      );
    }
  });

  /**
   * PATCH /automations/:automationId
   */
  app.patch("/automations/:automationId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON" }, 400);

    const userId = (body.userId as string) ?? (c.get("userId") as string);
    // Service-key workspace confinement (Item 3): pin/clamp before the workspace
    // reaches getCaller OR the re-supplied updateAutomation input.
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(
        c,
        body.workspaceId as string | undefined
      );
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.automations.updateAutomation({
        userId,
        workspaceId,
        id: c.req.param("automationId"),
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        triggerType: body.triggerType as
          | "event"
          | "cron"
          | "webhook"
          | "manual"
          | undefined,
        triggerConfig: body.triggerConfig as
          | Record<string, unknown>
          | undefined,
        flowDefinition: body.flowDefinition as
          | {
              nodes: Record<string, unknown>[];
              edges: Record<string, unknown>[];
            }
          | undefined,
        status: body.status as
          | "draft"
          | "active"
          | "paused"
          | "error"
          | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /automations/:automationId/activate
   */
  app.post("/automations/:automationId/activate", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const userId = (body.userId as string) ?? (c.get("userId") as string);
    // Service-key workspace confinement (Item 3): pin/clamp before the workspace
    // reaches getCaller OR the re-supplied activateAutomation input.
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(
        c,
        body.workspaceId as string | undefined
      );
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.automations.activateAutomation({
        userId,
        workspaceId,
        id: c.req.param("automationId"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.activate failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /automations/:automationId/pause
   */
  app.post("/automations/:automationId/pause", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const userId = (body.userId as string) ?? (c.get("userId") as string);
    // Service-key workspace confinement (Item 3): pin/clamp before the workspace
    // reaches getCaller OR the re-supplied pauseAutomation input.
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(
        c,
        body.workspaceId as string | undefined
      );
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }

    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.automations.pauseAutomation({
        userId,
        workspaceId,
        id: c.req.param("automationId"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "automations.pause failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
