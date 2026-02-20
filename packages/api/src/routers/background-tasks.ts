/**
 * Background Tasks Router
 *
 * Synchronous CRUD operations for background tasks.
 * Direct DB operations with inline permission checks.
 * Task definitions are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc } from "@synap/database";
import { backgroundTasks } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";

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
        context: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const taskId = randomUUID();

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: input.workspaceId,
        subjectType: "backgroundTask",
        action: "create",
        data: { id: taskId, name: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { id: taskId, status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const [task] = await db
        .insert(backgroundTasks)
        .values({
          id: taskId,
          userId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
          schedule: input.schedule,
          action: input.action,
          context: input.context || {},
          status: "active",
        })
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "backgroundTask",
        action: "create",
        phase: "completed",
        subjectId: task.id,
        userId,
        workspaceId: input.workspaceId,
        data: { name: input.name, type: input.type },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "backgroundTask",
        action: "create",
        subjectId: task.id,
        userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: task.id,
        status: "created" as const,
      };
    }),

  /**
   * Update a background task
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        schedule: z.string().optional(),
        action: z.string().min(1).optional(),
        context: z.record(z.string(), z.unknown()).optional(),
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingTask.workspaceId || undefined,
        subjectType: "backgroundTask",
        action: "update",
        data: { id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const [_updated] = await db
        .update(backgroundTasks)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(and(eq(backgroundTasks.id, id), eq(backgroundTasks.userId, userId)))
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "backgroundTask",
        action: "update",
        phase: "completed",
        subjectId: id,
        userId,
        workspaceId: existingTask.workspaceId || undefined,
        data: updateData,
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "backgroundTask",
        action: "update",
        subjectId: id,
        userId,
        workspaceId: existingTask.workspaceId || undefined,
      });

      return {
        status: "updated" as const,
      };
    }),

  /**
   * Delete a background task
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingTask.workspaceId || undefined,
        subjectType: "backgroundTask",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      await db
        .delete(backgroundTasks)
        .where(and(eq(backgroundTasks.id, input.id), eq(backgroundTasks.userId, userId)));

      // 3. Audit log
      auditLog({
        subjectType: "backgroundTask",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existingTask.workspaceId || undefined,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "backgroundTask",
        action: "delete",
        subjectId: input.id,
        userId,
        workspaceId: existingTask.workspaceId || undefined,
      });

      return {
        status: "deleted" as const,
      };
    }),
});
