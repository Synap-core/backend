/**
 * Background Tasks Executor
 *
 * Handles validated background task events.
 * Stores task definitions in the database for the Intelligence Service to fetch.
 */

import { inngest } from "../client.js";
import { db, backgroundTasks, eq } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const backgroundTasksExecutor = inngest.createFunction(
  {
    id: "background-tasks-executor",
    name: "Background Tasks Executor",
    retries: 3,
  },
  [
    { event: "background_tasks.create.validated" },
    { event: "background_tasks.update.validated" },
    { event: "background_tasks.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[backgroundTasksExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-background-task-operation", async () => {
      if (action === "create") {
        const [task] = await db
          .insert(backgroundTasks)
          .values({
            userId: data.userId as string,
            workspaceId: (data.workspaceId as string | undefined) || null,
            name: data.name as string,
            description: (data.description as string | undefined) || null,
            type: data.type as "cron" | "event" | "interval",
            schedule: (data.schedule as string | undefined) || null,
            action: data.action as string,
            context:
              (data.context as Record<string, unknown> | undefined) || {},
            status: "active",
            executionCount: 0,
            successCount: 0,
            failureCount: 0,
            metadata: {},
          })
          .returning();

        return {
          status: "completed",
          taskId: task.id,
          message: "Background task created successfully",
        };
      }

      if (action === "update") {
        const updateData: Record<string, unknown> = {};

        if (data.name !== undefined) updateData.name = data.name as string;
        if (data.description !== undefined)
          updateData.description = data.description as string;
        if (data.schedule !== undefined)
          updateData.schedule = data.schedule as string;
        if (data.action !== undefined)
          updateData.action = data.action as string;
        if (data.context !== undefined)
          updateData.context = data.context as Record<string, unknown>;
        if (data.status !== undefined)
          updateData.status = data.status as "active" | "paused" | "error";

        // Reset error status if updating
        if (data.status === "active" && data.status !== undefined) {
          updateData.errorMessage = null;
        }

        updateData.updatedAt = new Date();

        const [task] = await db
          .update(backgroundTasks)
          .set(updateData)
          .where(eq(backgroundTasks.id, data.taskId as string))
          .returning();

        if (!task) {
          throw new Error(`Background task not found: ${data.taskId}`);
        }

        return {
          status: "completed",
          taskId: task.id,
          message: "Background task updated successfully",
        };
      }

      if (action === "delete") {
        await db
          .delete(backgroundTasks)
          .where(eq(backgroundTasks.id, data.taskId as string));

        return {
          status: "completed",
          taskId: data.taskId as string,
          message: "Background task deleted successfully",
        };
      }

      throw new Error(`Unknown action: ${action}`);
    });
  }
);
