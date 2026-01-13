/**
 * Capture Router - Thought Capture API
 *
 * This is the main entry point for capturing user thoughts.
 *
 * Flow (Flow 2):
 * 1. Try plugins first (if any enabled)
 * 2. Fallback to local simple processing (Inngest event)
 *
 * This allows power users to connect their own Intelligence Hub via plugins,
 * while keeping a simple fallback for basic usage.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { Inngest } from "inngest";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import { pluginManager } from "../plugins/index.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "capture-router" });

// Create Inngest client (avoid circular dependency with @synap/jobs)
const inngest = new Inngest({ id: "synap-api" });

export const captureRouter = router({
  /**
   * Capture a raw thought
   *
   * Flow:
   * 1. Try plugins first (if any enabled and can process thoughts)
   * 2. Fallback to local simple processing (Inngest event)
   *
   * This allows extensibility while keeping a simple default.
   */
  thought: protectedProcedure
    .use(aiRateLimitMiddleware) // V1.0: Stricter rate limiting for AI endpoints
    .input(
      z.object({
        content: z.string().min(1).describe("Raw thought content"),
        context: z
          .record(z.any())
          .optional()
          .describe("Optional context metadata"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      logger.debug(
        { userId, contentLength: input.content.length },
        "Processing thought capture",
      );

      // Step 1: Try plugins first
      try {
        const pluginResult = await pluginManager.processThought({
          content: input.content,
          userId,
          context: input.context || {},
        });

        if (pluginResult && pluginResult.success) {
          logger.info(
            { userId, requestId: pluginResult.requestId, mode: "plugin" },
            "Thought processed via plugin",
          );
          return {
            success: true,
            message: "Thought processed via plugin",
            requestId: pluginResult.requestId,
            mode: "plugin",
          };
        }
      } catch (error) {
        logger.warn(
          { err: error, userId },
          "Plugin processing failed, falling back to local",
        );
        // Continue to fallback
      }

      // Step 2: Fallback to local simple processing
      logger.debug({ userId }, "Using local simple processing (fallback)");

      await inngest.send({
        name: "api/thought.captured",
        data: {
          content: input.content,
          context: input.context || {},
          capturedAt: new Date().toISOString(),
          userId,
          inputType: "text", // MVP: text only, will support voice/image later
        },
      });

      return {
        success: true,
        message: "Thought captured and queued for local analysis",
        mode: "local",
      };
    }),
});
