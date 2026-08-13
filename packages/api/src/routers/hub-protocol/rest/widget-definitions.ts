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

import {
  confineWorkspaceOrForbidden,
  getCaller,
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";

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
    // SERVICE-KEY CONFINEMENT (Item 3): inner `widgetDefinitions.upsertWidgetDef`
    // is a scopedProcedure that reads `input.workspaceId` (NOT ctx) — positive-pin
    // the value BEFORE it flows to resolveActingContext, the caller ctx, and the
    // input (mismatching body → 403). The input is re-supplied via the `...body`
    // spread below, so the clamped value must OVERRIDE `body.workspaceId` there.
    const confined = confineWorkspaceOrForbidden(
      c,
      (body.workspaceId as string | null | undefined) ?? null
    );
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const clampedWorkspaceId = confined.workspaceId;
    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    const acting = await resolveActingContext(c, {
      userId: body.userId as string | undefined,
      ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const userId = acting.userId;
    const workspaceId = acting.workspaceId;
    // SECURITY — agentUserId is the GOVERNANCE actor for widget.register; it must
    // be grant-checked, not trusted from the body. Without this, the `...body`
    // spread carried a caller-supplied agentUserId straight into
    // checkPermissionOrPropose — forging attribution onto another user's agent
    // (assertMayActAs validates userId only). Mirrors cell-instances / commands.
    const resolvedAgentUserId =
      (body.agentUserId as string | undefined) ??
      (c.get("agentUserId") as string | undefined);
    const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId,
        sourceMessageId: (body.sourceMessageId as string) ?? null,
      });
      const result = await caller.widgetDefinitions.upsertWidgetDef({
        ...body,
        userId,
        workspaceId,
        agentUserId: resolvedAgentUserId,
      } as Parameters<typeof caller.widgetDefinitions.upsertWidgetDef>[0]);
      return c.json(result);
    } catch (err) {
      // SERVICE-KEY CONFINEMENT: FORBIDDEN → 403, not a blanket 500. Duck-typed
      // on `.code` (bundled-build TRPCError identity defeats instanceof).
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      logger.error({ err }, "widgetDefinitions.upsertWidgetDef failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
