/**
 * Hub Protocol REST — UI surface gateway
 *
 * Allows IS agents and the CLI to tell the browser to open any surface
 * (entity, view, cell, document, channel, or app) for a given user.
 *
 * Routes:
 *   POST /ui/focus — emit a ui:focus event to the user's browser
 */

import { z } from "@hono/zod-openapi";
import { emitTyped } from "../../../utils/event-emit.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const SurfaceSchema = z.object({
  kind: z.enum(["cell", "view", "entity", "document", "channel", "app"]),
  cellKey: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  viewId: z.string().optional(),
  entityId: z.string().optional(),
  documentId: z.string().optional(),
  channelId: z.string().optional(),
  appId: z.string().optional(),
  placement: z.enum(["main", "side"]).optional(),
  title: z.string().optional(),
  workspaceId: z.string().optional(),
});

const FocusBodySchema = z.object({
  surface: SurfaceSchema,
});

const FocusResponseSchema = z.object({
  ok: z.literal(true),
});

// ── Registration ───────────────────────────────────────────────────────────

export function registerUiRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/ui/focus",
    tags: ["UI"],
    summary: "Open a surface in the user's browser",
    description:
      "Emits a ui:focus event to the authenticated user's browser, instructing it to open the specified surface (entity, view, cell, document, channel, or app).",
    request: {
      body: FocusBodySchema,
    },
    responses: {
      200: {
        description: "Event emitted",
        schema: FocusResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  /**
   * POST /ui/focus
   * Emit a ui:focus realtime event to the calling user's browser.
   */
  app.post("/ui/focus", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let body: { surface: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = FocusBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => {
          const path = i.path.join(".");
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join(", ");
      return c.json({ error: message || "Validation failed" }, 400);
    }

    const userId = c.get("userId") as string;
    const { surface } = parsed.data;

    logger.info({ userId, surface }, "ui:focus emitted");

    await emitTyped("ui:focus", { surface }, { userId });

    return c.json({ ok: true as const });
  });
}
