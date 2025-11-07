/**
 * Events Router - Event Logging API
 * 
 * This is the PRIMARY entry point for modifying system state.
 * All state changes MUST go through the event log.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { requireUserId } from '../utils/user-scoped.js';
import {
  eventService,
  AggregateTypeSchema,
  EventSourceSchema,
} from '@synap/domain';

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
        aggregateId: z.string().uuid(),
        aggregateType: AggregateTypeSchema,
        eventType: z.string().min(1),
        data: z.record(z.unknown()),
        metadata: z.record(z.string(), z.unknown()).optional(),
        version: z.number().int().positive(),
        source: EventSourceSchema.optional(),
        causationId: z.string().uuid().optional(),
        correlationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const record = await eventService.append({
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        eventType: input.eventType,
        userId,
        data: input.data,
        metadata: input.metadata,
        version: input.version,
        causationId: input.causationId,
        correlationId: input.correlationId,
        source: input.source,
      });

      return record;
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

      const events = await eventService.getUserStream(userId, {
        limit: input.limit,
        eventTypes: input.type ? [input.type] : undefined,
      });

      return events;
    }),
});

