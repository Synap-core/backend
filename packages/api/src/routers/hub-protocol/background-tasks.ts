/**
 * Hub Protocol - Background Tasks Router
 *
 * Thin wrapper around regular API endpoints.
 * Allows Intelligence Service to fetch and manage background tasks.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { backgroundTasksRouter as regularBackgroundTasksRouter } from "../background-tasks.js";
import { createHubProtocolCallerContext } from "./utils.js";

export const backgroundTasksRouter = router({
  /**
   * Get background tasks for user
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's list endpoint internally
   */
  getBackgroundTasks: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        status: z.enum(["active", "paused", "error", "all"]).optional(),
        type: z.enum(["cron", "event", "interval"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Call regular API's list endpoint
      const result = await caller.list({
        workspaceId: input.workspaceId,
        status: input.status || "all",
        type: input.type,
        limit: 100, // Get all tasks
      });

      return result.tasks;
    }),

  /**
   * Get a single background task by ID
   * Requires: hub-protocol.read scope
   */
  getBackgroundTask: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        taskId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Call regular API's get endpoint
      const result = await caller.get({
        id: input.taskId,
      });

      return result.task;
    }),

  /**
   * Update task execution tracking
   * Requires: hub-protocol.write scope
   *
   * Called by Intelligence Service after task execution
   */
  updateTaskExecution: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        taskId: z.string().uuid(),
        lastRunAt: z.date().optional(),
        nextRunAt: z.date().optional(),
        executionCount: z.number().optional(),
        successCount: z.number().optional(),
        failureCount: z.number().optional(),
        errorMessage: z.string().optional(),
        status: z.enum(["active", "paused", "error"]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularBackgroundTasksRouter.createCaller(callerContext);

      // Update task with execution results
      // Note: This is a direct update (not via events) for execution tracking
      // The task definition itself is updated via events, but execution tracking
      // can be updated directly for performance
      const { taskId, userId, ...updateData } = input;

      // For now, we'll use the update endpoint which goes through events
      // In the future, we might want a direct update endpoint for execution tracking
      await caller.update({
        id: taskId,
        ...updateData,
      });

      return { success: true };
    }),
});
