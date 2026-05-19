/**
 * Webhook Routes - Intelligence Service Callbacks
 *
 * Handles callbacks from intelligence services (e.g., analysis results).
 */

import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import { db, inboxItems, eq } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { z } from "zod";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const logger = createLogger({ module: "intelligence-webhooks" });

export const intelligenceWebhookRouter = new Hono();

// Callback payload schema
const AnalysisCallbackSchema = z.object({
  requestId: z.string(),
  itemId: z.string(),
  analysis: z
    .object({
      priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      summary: z.string().optional(),
    })
    .passthrough(),
});

/**
 * Intelligence Service Callback
 *
 * POST /webhooks/intelligence/callback
 *
 * Called by intelligence services to return analysis results.
 */
intelligenceWebhookRouter.post("/callback", async (c) => {
  // Auth: Bearer token check
  const expectedToken = process.env.INTELLIGENCE_SERVICE_API_KEY;
  if (expectedToken) {
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!safeCompare(token, expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  } else {
    // TODO: INTELLIGENCE_SERVICE_API_KEY should be required in production
    logger.warn(
      "INTELLIGENCE_SERVICE_API_KEY not set — skipping auth (dev mode)"
    );
  }

  try {
    const body = await c.req.json();
    const { requestId, itemId, analysis } = AnalysisCallbackSchema.parse(body);

    logger.info({ requestId, itemId }, "Received intelligence callback");

    const inboxItem = await db.query.inboxItems.findFirst({
      where: eq(inboxItems.id, itemId),
      columns: { userId: true },
    });

    const userId = inboxItem?.userId ?? "system";

    await emitSideEffects({
      subjectType: "inbox_item",
      action: "analyzed",
      subjectId: itemId,
      userId,
      data: { requestId, analysis },
    }).catch((err) =>
      logger.warn({ err }, "emitSideEffects failed (non-fatal)")
    );

    logger.info({ requestId, itemId }, "Intelligence callback processed");

    return c.json({ success: true });
  } catch (error: any) {
    logger.error({ error }, "Intelligence callback handler error");

    if (error.name === "ZodError") {
      return c.json({ error: "Invalid payload", details: error.errors }, 400);
    }

    return c.json(
      { error: "Internal server error", message: error.message },
      500
    );
  }
});

/**
 * Health check
 */
intelligenceWebhookRouter.get("/health", (c) => {
  return c.json({ status: "ok", service: "intelligence-webhooks" });
});
