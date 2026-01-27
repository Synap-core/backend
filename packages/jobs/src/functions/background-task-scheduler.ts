/**
 * Background Task Scheduler
 *
 * Schedules and executes background tasks based on their type:
 * - cron: Scheduled using cron expressions
 * - event: Triggered by specific events
 * - interval: Recurring at fixed intervals
 */

import { inngest } from "../client.js";
import { db, backgroundTasks, eq, and, lte } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "background-task-scheduler" });

/**
 * Background Task Scheduler Worker
 * Runs every minute to check for tasks that need to be executed
 */
export const backgroundTaskScheduler = inngest.createFunction(
  {
    id: "background-task-scheduler",
    name: "Background Task Scheduler",
    retries: 1,
  },
  { cron: "* * * * *" }, // Run every minute
  async ({ step }) => {
    return await step.run("check-and-execute-tasks", async () => {
      const now = new Date();

      // Find tasks that need to be executed
      const tasksToExecute = await db.query.backgroundTasks.findMany({
        where: and(
          eq(backgroundTasks.status, "active"),
          lte(backgroundTasks.nextRunAt, now)
        ),
        limit: 50, // Process up to 50 tasks per run
      });

      if (tasksToExecute.length === 0) {
        return {
          status: "no_tasks",
          message: "No tasks scheduled for execution",
          timestamp: now.toISOString(),
        };
      }

      logger.info(`Found ${tasksToExecute.length} tasks to execute`);

      // Execute each task
      const results = await Promise.allSettled(
        tasksToExecute.map((task) =>
          step.run(`execute-task-${task.id}`, async () => {
            // Send event to Intelligence Service to execute the task
            await inngest.send({
              name: "background_task.execute",
              data: {
                taskId: task.id,
                userId: task.userId,
                workspaceId: task.workspaceId,
                action: task.action,
                context: task.context,
              },
              user: { id: task.userId },
            });

            // Calculate next run time based on task type
            const nextRunAt = calculateNextRunTime(task, now);

            // Update task with next run time
            await db
              .update(backgroundTasks)
              .set({
                nextRunAt,
                updatedAt: new Date(),
              })
              .where(eq(backgroundTasks.id, task.id));

            return {
              taskId: task.id,
              taskName: task.name,
              nextRunAt: nextRunAt.toISOString(),
            };
          })
        )
      );

      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      return {
        status: "completed",
        totalTasks: tasksToExecute.length,
        successful,
        failed,
        timestamp: now.toISOString(),
      };
    });
  }
);

/**
 * Calculate next run time for a task based on its type and schedule
 */
function calculateNextRunTime(
  task: {
    type: "cron" | "event" | "interval";
    schedule?: string | null;
  },
  currentTime: Date
): Date {
  const nextRun = new Date(currentTime);

  switch (task.type) {
    case "cron":
      // For cron tasks, parse the schedule and calculate next run
      // This is a simplified version - in production, use a proper cron parser
      if (task.schedule) {
        // Parse cron expression (e.g., "0 9 * * *" = daily at 9 AM)
        const cronParts = task.schedule.split(" ");
        if (cronParts.length === 5) {
          const [minute, hour, day, month, weekday] = cronParts;

          // Simple implementation: if hour is specified, set it
          if (hour !== "*") {
            nextRun.setHours(
              parseInt(hour, 10),
              minute !== "*" ? parseInt(minute, 10) : 0,
              0,
              0
            );
            // If time has passed today, schedule for tomorrow
            if (nextRun <= currentTime) {
              nextRun.setDate(nextRun.getDate() + 1);
            }
          } else {
            // Default: run in 1 hour if no schedule specified
            nextRun.setHours(nextRun.getHours() + 1);
          }
        } else {
          // Invalid cron - default to 1 hour
          nextRun.setHours(nextRun.getHours() + 1);
        }
      } else {
        // No schedule - default to 1 hour
        nextRun.setHours(nextRun.getHours() + 1);
      }
      break;

    case "interval":
      // Parse interval (e.g., "1h", "30m", "1d")
      if (task.schedule) {
        const intervalMatch = task.schedule.match(/^(\d+)([hmsd])$/);
        if (intervalMatch) {
          const [, value, unit] = intervalMatch;
          const numValue = parseInt(value, 10);

          switch (unit) {
            case "h":
              nextRun.setHours(nextRun.getHours() + numValue);
              break;
            case "m":
              nextRun.setMinutes(nextRun.getMinutes() + numValue);
              break;
            case "s":
              nextRun.setSeconds(nextRun.getSeconds() + numValue);
              break;
            case "d":
              nextRun.setDate(nextRun.getDate() + numValue);
              break;
          }
        } else {
          // Invalid interval - default to 1 hour
          nextRun.setHours(nextRun.getHours() + 1);
        }
      } else {
        // No schedule - default to 1 hour
        nextRun.setHours(nextRun.getHours() + 1);
      }
      break;

    case "event":
      // Event-driven tasks don't have a next run time
      // They're triggered by events, so return current time
      // (they'll be updated when the event triggers)
      return currentTime;

    default:
      // Unknown type - default to 1 hour
      nextRun.setHours(nextRun.getHours() + 1);
  }

  return nextRun;
}
