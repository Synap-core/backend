/**
 * Capture Router - Thought Capture API
 * 
 * This is the main entry point for capturing user thoughts.
 * The AI will analyze and create appropriate entities.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { requireUserId } from '../utils/user-scoped.js';
import { Inngest } from 'inngest';
import { aiRateLimitMiddleware } from '../middleware/ai-rate-limit.js';

// Create Inngest client (avoid circular dependency with @synap/jobs)
const inngest = new Inngest({ id: 'synap-api' });

export const captureRouter = router({
  /**
   * Capture a raw thought
   * 
   * The thought will be analyzed by AI and transformed into
   * the appropriate entity (note, task, etc.)
   */
  thought: protectedProcedure
    .use(aiRateLimitMiddleware) // V1.0: Stricter rate limiting for AI endpoints
    .input(
      z.object({
        content: z.string().min(1).describe('Raw thought content'),
        context: z.record(z.any()).optional().describe('Optional context metadata'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Emit Inngest event for async processing
      await inngest.send({
        name: 'api/thought.captured',
        data: {
          content: input.content,
          context: input.context || {},
          capturedAt: new Date().toISOString(),
          userId, // ✅ Pass userId for multi-user processing
        },
      });

      return {
        success: true,
        message: 'Thought captured and queued for analysis',
      };
    }),
});

