/**
 * Hub Protocol REST — notifications (IS → backend notification persistence)
 */

import { NotificationService } from "../../../notifications/NotificationService.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateNotificationRequestSchema,
  CreateNotificationResponseSchema,
} from "./_codecs/notification.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

export function registerNotificationsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/notifications",
    tags: ["Notifications"],
    summary: "Create a notification",
    description:
      "Persists a notification (e.g. skill.triggered) and emits notification:new to the frontend.",
    request: {
      body: CreateNotificationRequestSchema,
    },
    responses: {
      200: {
        description: "Created notification id",
        schema: CreateNotificationResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /notifications
   * IS calls this to persist a notification (e.g. skill.triggered) and emit
   * notification:new to the frontend. Backend-originated notifications (vault,
   * proposals) use NotificationService directly — this endpoint is for IS-side events.
   */
  app.post("/notifications", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const body = (await c.req.json()) as {
      userId: string;
      workspaceId: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      workspaceUrl?: string;
      groupKey?: string;
      data?: Record<string, unknown>;
    };

    if (!body.userId || !body.workspaceId || !body.type) {
      return c.json(
        { error: "userId, workspaceId, and type are required" },
        400
      );
    }

    // Item 3 Part 3: confine a bound service key to its workspace before the write.
    const workspaceId = getConfinedWorkspace(c, body.workspaceId);

    try {
      const id = await NotificationService.create({
        workspaceId,
        userId: body.userId,
        type: body.type,
        sourceType: (body.sourceType ?? "system") as
          | "proposal"
          | "connector"
          | "agent"
          | "system"
          | "inbox_item",
        sourceId: body.sourceId,
        workspaceUrl: body.workspaceUrl,
        groupKey: body.groupKey,
        data: body.data ?? {},
      });

      return c.json({ id });
    } catch (err) {
      logger.error({ err }, "notifications.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
