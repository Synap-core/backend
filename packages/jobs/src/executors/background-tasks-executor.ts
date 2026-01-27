/**
 * Background Tasks Executor
 *
 * Handles validated background task events.
 * Stores task definitions in the database for the Intelligence Service to fetch.
 */

import { inngest } from "../client.js";
import { db, backgroundTasks, eq } from "@synap/database";
import { randomUUID } from "crypto";

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
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-background-task-operation", async () => {
      if (eventType === "background_tasks.create.validated") {
        const taskId = randomUUID();

        const [task] = await db
          .insert(backgroundTasks)
          .values({
            id: taskId,
            userId: data.userId,
            workspaceId: data.workspaceId || null,
            name: data.name,
            description: data.description || null,
            type: data.type,
            schedule: data.schedule || null,
            action: data.action,
            context: data.context || {},
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

      if (eventType === "background_tasks.update.validated") {
        const updateData: Record<string, unknown> = {};

        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined)
          updateData.description = data.description;
        if (data.schedule !== undefined) updateData.schedule = data.schedule;
        if (data.action !== undefined) updateData.action = data.action;
        if (data.context !== undefined) updateData.context = data.context;
        if (data.status !== undefined) updateData.status = data.status;

        // Reset error status if updating
        if (data.status === "active" && data.status !== undefined) {
          updateData.errorMessage = null;
        }

        updateData.updatedAt = new Date();

        const [task] = await db
          .update(backgroundTasks)
          .set(updateData)
          .where(eq(backgroundTasks.id, data.taskId))
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

      if (eventType === "background_tasks.delete.validated") {
        await db
          .delete(backgroundTasks)
          .where(eq(backgroundTasks.id, data.taskId));

        return {
          status: "completed",
          taskId: data.taskId,
          message: "Background task deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
