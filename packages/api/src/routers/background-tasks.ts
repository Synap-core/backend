/**
 * Background Tasks Router (tRPC)
 *
 * Thin wrapper over `services/background-tasks-service.ts` so the tRPC and
 * Hub Protocol REST surfaces share one validation + permission code path.
 *
 * Action validation lives in `services/background-task-actions.ts` — both
 * surfaces reject unknown action ids using the same registry.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  BackgroundTaskPermissionError,
  InvalidActionError,
  createBackgroundTask,
  deleteBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  updateBackgroundTask,
} from "../services/background-tasks-service.js";

/** Map service-layer errors to TRPCError so the wire shape matches the legacy router. */
function mapServiceError(err: unknown): never {
  if (err instanceof InvalidActionError) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: err.message,
      cause: { validActions: err.validActions },
    });
  }
  if (err instanceof BackgroundTaskPermissionError) {
    if (err.kind === "denied") {
      throw new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    // proposed — caller wants the proposalId echoed back, not an error.
    // We re-throw a typed error and unwrap at the procedure layer because
    // tRPC return shapes can't be union'd through `mapServiceError`.
    throw err;
  }
  if (err instanceof Error && err.name === "BackgroundTaskNotFoundError") {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw err;
}

export const backgroundTasksRouter = router({
  /**
   * List background tasks for the current user.
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
      return listBackgroundTasks({
        userId,
        workspaceId: input?.workspaceId,
        status: input?.status,
        type: input?.type,
        limit: input?.limit,
        offset: input?.offset,
      });
    }),

  /**
   * Get a single background task by ID.
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const task = await getBackgroundTask({ id: input.id, userId });
      if (!task) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Background task not found",
        });
      }
      return { task };
    }),

  /**
   * Create a new background task.
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        type: z.enum(["cron", "event", "interval"]),
        schedule: z.string().optional(),
        action: z.string().min(1),
        context: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      try {
        const { id } = await createBackgroundTask({
          userId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
          schedule: input.schedule,
          action: input.action,
          context: input.context,
        });
        return { id, status: "created" as const };
      } catch (err) {
        if (
          err instanceof BackgroundTaskPermissionError &&
          err.kind === "proposed"
        ) {
          return {
            id: "",
            status: "proposed" as const,
            proposalId: err.proposalId,
          };
        }
        return mapServiceError(err);
      }
    }),

  /**
   * Update a background task.
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
        nextRunAt: z.union([z.string(), z.date()]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      try {
        await updateBackgroundTask({
          id: input.id,
          userId,
          name: input.name,
          description: input.description,
          schedule: input.schedule,
          action: input.action,
          context: input.context,
          status: input.status,
          nextRunAt: input.nextRunAt,
        });
        return { status: "updated" as const };
      } catch (err) {
        if (
          err instanceof BackgroundTaskPermissionError &&
          err.kind === "proposed"
        ) {
          return {
            status: "proposed" as const,
            proposalId: err.proposalId,
          };
        }
        return mapServiceError(err);
      }
    }),

  /**
   * Delete a background task.
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      try {
        await deleteBackgroundTask({ id: input.id, userId });
        return { status: "deleted" as const };
      } catch (err) {
        if (
          err instanceof BackgroundTaskPermissionError &&
          err.kind === "proposed"
        ) {
          return {
            status: "proposed" as const,
            proposalId: err.proposalId,
          };
        }
        return mapServiceError(err);
      }
    }),
});
