/**
 * Hub Protocol REST — widget definitions (registry)
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  ListWidgetDefsQuerySchema,
  UpsertWidgetDefRequestSchema,
  WireWidgetDefSchema,
} from "./_codecs/widget.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerWidgetDefinitionsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/widget-definitions",
    tags: ["Widgets"],
    summary: "List widget definitions",
    request: {
      query: ListWidgetDefsQuerySchema,
    },
    responses: {
      200: {
        description: "Widget definitions",
        schema: z.array(WireWidgetDefSchema),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/widget-definitions",
    tags: ["Widgets"],
    summary: "Register or update a widget definition",
    request: {
      body: UpsertWidgetDefRequestSchema,
    },
    responses: {
      200: {
        description: "Upserted widget definition",
        schema: WireWidgetDefSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /widget-definitions?workspaceId=...
   */
  app.get("/widget-definitions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const workspaceId = c.req.query("workspaceId");
    try {
      const caller = await getCaller(c, { workspaceId: workspaceId ?? null });
      const result = await caller.widgetDefinitions.listWidgetDefs({
        workspaceId: workspaceId ?? null,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "widgetDefinitions.listWidgetDefs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /widget-definitions
   */
  app.post("/widget-definitions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    const userId = (body.userId as string) ?? (c.get("userId") as string);
    const workspaceId = (body.workspaceId as string | null | undefined) ?? null;
    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId,
        sourceMessageId: (body.sourceMessageId as string) ?? null,
      });
      const result = await caller.widgetDefinitions.upsertWidgetDef({
        ...body,
        userId,
      } as Parameters<typeof caller.widgetDefinitions.upsertWidgetDef>[0]);
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "widgetDefinitions.upsertWidgetDef failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
