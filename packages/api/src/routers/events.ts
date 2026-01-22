/**
 * Events Router - Event Logging API
 *
 * V0.6: Refactored to use direct event publishing instead of deprecated eventService
 *
 * This is the PRIMARY entry point for modifying system state.
 * All state changes MUST go through the event log.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
// REMOVED: Domain package - using simple string schemas instead
// import { subjectTypeSchema, EventSourceSchema } from '@synap/domain';
import { createSynapEvent } from "@synap-core/core";
import type { EventType } from "@synap/events";
import { getEventRepository } from "@synap/database";
import { publishEvent } from "../utils/inngest-client.js";
import { randomUUID } from "crypto";

// Temporary schemas until we refactor
const subjectTypeSchema = z.enum(["entity", "relation", "user", "system"]);
const EventSourceSchema = z.enum([
  "api",
  "automation",
  "sync",
  "migration",
  "system",
]);

export const eventsRouter = router({
  /**
   * Log a new event
   *
   * V0.6: Refactored to use direct event publishing
   *
   * This is the ONLY way to modify system state.
   * The event will be stored immutably and trigger projectors.
   */
  log: protectedProcedure
    .input(
      z.object({
        subjectId: z.string().uuid(),
        subjectType: subjectTypeSchema,
        eventType: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
        metadata: z.record(z.string(), z.unknown()).optional(),
        version: z.number().int().positive(),
        source: EventSourceSchema.optional(),
        causationId: z.string().uuid().optional(),
        correlationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const requestId = randomUUID();
      const correlationId = input.correlationId || randomUUID();

      // Create SynapEvent
      const event = createSynapEvent({
        type: input.eventType as EventType,
        userId,
        subjectId: input.subjectId,
        data: input.data,
        source: input.source || "api",
        requestId,
        correlationId,
        causationId: input.causationId,
        metadata: input.metadata,
      });

      // Append to Event Store
      const eventRepo = getEventRepository();
      const eventRecord = await eventRepo.append(event);

      // Publish to Inngest
      await publishEvent(
        "api/event.logged",
        {
          id: eventRecord.id,
          type: eventRecord.eventType,
          subjectId: eventRecord.subjectId,
          subjectType: input.subjectType,
          userId: eventRecord.userId,
          version: input.version,
          timestamp: eventRecord.timestamp.toISOString(),
          data: eventRecord.data,
          metadata: {
            version: eventRecord.version,
            requestId: eventRecord.metadata?.requestId,
            ...input.metadata,
          },
          source: eventRecord.source,
          causationId: eventRecord.causationId,
          correlationId: eventRecord.correlationId,
          requestId: eventRecord.metadata?.requestId,
        },
        userId
      );

      return eventRecord;
    }),

  /**
   * Get events for current user
   *
   * V0.6: Refactored to use EventRepository directly
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

      // Use EventRepository directly instead of deprecated eventService
      const eventRepo = getEventRepository();
      const events = await eventRepo.getUserStream(userId, {
        limit: input.limit,
        eventTypes: input.type ? [input.type] : undefined,
      });

      return events;
    }),
});
