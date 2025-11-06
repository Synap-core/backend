/**
 * Capture Router - Thought Capture API
 * 
 * This is the main entry point for capturing user thoughts.
 * The AI will analyze and create appropriate entities.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { inngest } from '@synap/jobs';

export const captureRouter = router({
  /**
   * Capture a raw thought
   * 
   * The thought will be analyzed by AI and transformed into
   * the appropriate entity (note, task, etc.)
   */
  thought: protectedProcedure
    .input(
      z.object({
        content: z.string().min(1).describe('Raw thought content'),
        context: z.record(z.any()).optional().describe('Optional context metadata'),
      })
    )
    .mutation(async ({ input }) => {
      // Emit Inngest event for async processing
      await inngest.send({
        name: 'api/thought.captured',
        data: {
          content: input.content,
          context: input.context || {},
          capturedAt: new Date().toISOString(),
        },
      });

      return {
        success: true,
        message: 'Thought captured and queued for analysis',
      };
    }),
});

