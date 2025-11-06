/**
 * Events Router - Event Logging API
 * 
 * This is the PRIMARY entry point for modifying system state.
 * All state changes MUST go through the event log.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { events } from '@synap/database';

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
      // Insert event into the immutable log
      const [event] = await ctx.db
        .insert(events)
        .values({
          type: input.type,
          data: input.data,
          source: input.source || 'api',
          correlationId: input.correlationId,
        })
        .returning();

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
      const query = ctx.db
        .select()
        .from(events)
        .limit(input.limit)
        .orderBy(events.timestamp);

      if (input.type) {
        // Add type filter if provided
        // query.where(eq(events.type, input.type));
      }

      return await query;
    }),
});

