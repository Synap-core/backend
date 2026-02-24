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
import { TRPCError } from "@trpc/server";
import { requireUserId } from "../utils/user-scoped.js";
// REMOVED: Domain package - using simple string schemas instead
// import { subjectTypeSchema, EventSourceSchema } from '@synap/domain';
import { createSynapEvent } from "@synap-core/core";
import { db, getEventRepository } from "@synap/database";
import type { EventType, SubjectType } from "@synap/events";
import { randomUUID } from "crypto";

// Temporary schemas until we refactor
const subjectTypeSchema = z.enum([
  "entity",
  "relation",
  "user",
  "system",
  "workspace",
  "project",
  "task",
  "document",
  "chat",
  "message",
  "apiKey",
  "member",
]) as z.ZodType<SubjectType>;
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

      // Append to Event Store (events are audit trail, no need to forward to job queue)
      const eventRepo = getEventRepository();
      const eventRecord = await eventRepo.append(event);

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

  /**
   * Search events (Admin/Owner access)
   *
   * Allows searching events with filters:
   * - System Admin: Can search ALL events
   * - Workspace Owner: Can search events for their workspace
   */
  search: protectedProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        eventType: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        subjectId: z.string().optional(),
        correlationId: z.string().optional(),
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        workspaceId: z.string().uuid().optional(), // Optional context for owners
      })
    )
    .query(async ({ ctx, input }) => {
      const eventRepo = getEventRepository();

      // Permission Check: workspace owner/admin, or scoped to own events
      // System admin = user who owns at least one workspace
      const ownedWorkspace = await db.query.workspaceMembers.findFirst({
        where: (members, { and, eq }) =>
          and(eq(members.userId, ctx.userId), eq(members.role, "owner")),
      });
      const isSystemAdmin = !!ownedWorkspace;

      if (input.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: (members, { and, eq }) =>
            and(
              eq(members.workspaceId, input.workspaceId!),
              eq(members.userId, ctx.userId)
            ),
        });

        if (!membership || !["owner", "admin"].includes(membership.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Insufficient permissions for this workspace",
          });
        }
      } else if (!isSystemAdmin) {
        // If not checking a specific workspace and not system admin, restrict to own events
        // This effectively makes it behave like 'list' but with more filters
        if (input.userId && input.userId !== ctx.userId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot view events of other users",
          });
        }
        // Force userId filter to current user if not system admin
        input.userId = ctx.userId;
      }

      // Perform search
      const events = await eventRepo.searchEvents({
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        correlationId: input.correlationId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        limit: input.limit,
        offset: input.offset,
      });

      return events;
    }),

  /**
   * Count events (for pagination/analytics)
   */
  count: protectedProcedure
    .input(
      z.object({
        userId: z.string().optional(),
        eventType: z.string().optional(),
        subjectType: subjectTypeSchema.optional(),
        fromDate: z.date().optional(),
        toDate: z.date().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const eventRepo = getEventRepository();

      // Same permission logic as search
      if (input.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: (members, { and, eq }) =>
            and(
              eq(members.workspaceId, input.workspaceId!),
              eq(members.userId, ctx.userId)
            ),
        });
        if (!membership || !["owner", "admin"].includes(membership.role)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
      } else {
        // Default to current user
        input.userId = ctx.userId;
      }

      const count = await eventRepo.countEvents({
        userId: input.userId,
        eventType: input.eventType,
        subjectType: input.subjectType,
        fromDate: input.fromDate,
        toDate: input.toDate,
      });

      return { count };
    }),
});
