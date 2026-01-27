/**
 * Background Tasks Router
 *
 * Handles CRUD operations for background tasks.
 * Task definitions are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, backgroundTasks, eq, and, desc } from "@synap/database";
import { requireUserId } from "../utils/user-scoped.js";
import { emitRequestEvent } from "../utils/emit-event.js";

export const backgroundTasksRouter = router({
  /**
   * List background tasks for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          status: z.enum(["active", "paused", "error", "all"]).optional(),
          type: z.enum(["cron", "event", "interval"]).optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const conditions = [eq(backgroundTasks.userId, userId)];

      if (input?.workspaceId) {
        conditions.push(eq(backgroundTasks.workspaceId, input.workspaceId));
      }

      if (input?.status && input.status !== "all") {
        conditions.push(eq(backgroundTasks.status, input.status));
      }

      if (input?.type) {
        conditions.push(eq(backgroundTasks.type, input.type));
      }

      const results = await ctx.db.query.backgroundTasks.findMany({
        where: and(...conditions),
        orderBy: [desc(backgroundTasks.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      return { tasks: results };
    }),

  /**
   * Get a single background task by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const task = await ctx.db.query.backgroundTasks.findFirst({
        where: and(
          eq(backgroundTasks.id, input.id),
          eq(backgroundTasks.userId, userId)
        ),
      });

      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Background task not found",
        });
      }

      return { task };
    }),

  /**
   * Create a new background task
   * Event-driven: emits background_tasks.create.requested
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        type: z.enum(["cron", "event", "interval"]),
        schedule: z.string().optional(), // Cron expression, event pattern, or interval
        action: z.string().min(1),
        context: z.record(z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Emit event for task creation
      await emitRequestEvent({
        type: "background_tasks.create.requested",
        data: {
          userId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
          schedule: input.schedule,
          action: input.action,
          context: input.context || {},
        },
        userId,
      });

      return {
        success: true,
        message: "Background task creation requested",
      };
    }),

  /**
   * Update a background task
   * Event-driven: emits background_tasks.update.requested
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        schedule: z.string().optional(),
        action: z.string().min(1).optional(),
        context: z.record(z.unknown()).optional(),
        status: z.enum(["active", "paused", "error"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { id, ...updateData } = input;

      // Verify task exists and belongs to user
      const existingTask = await ctx.db.query.backgroundTasks.findFirst({
        where: and(
          eq(backgroundTasks.id, id),
          eq(backgroundTasks.userId, userId)
        ),
      });

      if (!existingTask) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Background task not found",
        });
      }

      // Emit event for task update
      await emitRequestEvent({
        type: "background_tasks.update.requested",
        data: {
          taskId: id,
          ...updateData,
        },
        userId,
      });

      return {
        success: true,
        message: "Background task update requested",
      };
    }),

  /**
   * Delete a background task
   * Event-driven: emits background_tasks.delete.requested
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify task exists and belongs to user
      const existingTask = await ctx.db.query.backgroundTasks.findFirst({
        where: and(
          eq(backgroundTasks.id, input.id),
          eq(backgroundTasks.userId, userId)
        ),
      });

      if (!existingTask) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Background task not found",
        });
      }

      // Emit event for task deletion
      await emitRequestEvent({
        type: "background_tasks.delete.requested",
        data: {
          taskId: input.id,
        },
        userId,
      });

      return {
        success: true,
        message: "Background task deletion requested",
      };
    }),
});
