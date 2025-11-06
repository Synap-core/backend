/**
 * Events Router - Event Logging API
 * 
 * This is the PRIMARY entry point for modifying system state.
 * All state changes MUST go through the event log.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { router, protectedProcedure } from '../trpc.js';
import { events } from '@synap/database';
import { requireUserId } from '../utils/user-scoped.js';

export const eventsRouter = router({
  /**
   * Log a new event
   * 
   * This is the ONLY way to modify system state.
   * The event will be stored immutably and trigger projectors.
   */
  log: protectedProcedure
    .input(
      z.object({
        type: z.string().min(1).describe('Event type (e.g., "entity.created")'),
        data: z.record(z.any()).describe('Event payload'),
        source: z.enum(['api', 'automation', 'sync', 'migration']).optional(),
        correlationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Insert event into the immutable log
      // Type assertion needed for multi-dialect compatibility
      const result = await ctx.db
        .insert(events)
        .values({
          type: input.type,
          data: input.data,
          source: input.source || 'api',
          correlationId: input.correlationId,
          userId, // ✅ User isolation
        } as any)
        .returning();
      
      const event = Array.isArray(result) ? result[0] : result;

      // TODO: Trigger Inngest function to process this event
      // For now, we just return the event
      // In Phase 1.3, we'll add: await inngest.send({ name: 'api/event.logged', data: event });

      return event;
    }),

  /**
   * Get events for current user
   * 
   * Useful for debugging and audit trails
   */
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        type: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      
      // Build query with user isolation
      // Type assertions needed for multi-dialect compatibility
      const baseQuery = ctx.db
        .select()
        .from(events)
        .where(eq((events as any).userId, userId) as any) // ✅ User isolation
        .limit(input.limit);

      // Add optional type filter
      const finalQuery = input.type
        ? (baseQuery as any).where(eq((events as any).type, input.type))
        : baseQuery;

      return await finalQuery;
    }),
});

