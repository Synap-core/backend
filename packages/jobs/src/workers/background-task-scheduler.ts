/**
 * Background Task Scheduler Worker
 *
 * Cron-triggered worker that checks for and executes due background tasks.
 * Ported from Inngest function: background-task-scheduler.ts
 */

import { db, eq, backgroundTasks } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "background-task-scheduler" });

const INTELLIGENCE_HUB_URL =
  process.env.INTELLIGENCE_HUB_URL || "http://localhost:3001";
const HUB_PROTOCOL_API_KEY = process.env.HUB_PROTOCOL_API_KEY || "";

export async function handleBackgroundTaskScheduler(): Promise<void> {
  // Fetch tasks where status="active" AND nextRunAt <= now
  const now = new Date();

  const dueTasks = await db.query.backgroundTasks.findMany({
    where: (tasks, { and, eq, lte }) =>
      and(eq(tasks.status, "active"), lte(tasks.nextRunAt, now)),
    limit: 50,
  });

  if (dueTasks.length === 0) return;

  await Promise.allSettled(
    dueTasks.map(async (task) => {
      try {
        // Send execute event to Intelligence Service
        await fetch(`${INTELLIGENCE_HUB_URL}/api/tasks/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": HUB_PROTOCOL_API_KEY,
          },
          body: JSON.stringify({
            taskId: task.id,
            action: task.action,
            context: task.context,
            userId: task.userId,
            workspaceId: task.workspaceId,
          }),
        });

        // Calculate next run time
        const nextRunAt = calculateNextRunTime(task.type, task.schedule);

        await db
          .update(backgroundTasks)
          .set({
            lastRunAt: now,
            nextRunAt,
            updatedAt: now,
          })
          .where(eq(backgroundTasks.id, task.id));

        return { taskId: task.id, success: true };
      } catch (error) {
        logger.warn({ err: error, taskId: task.id }, "Background task execution failed");
        return { taskId: task.id, success: false };
      }
    })
  );

  logger.info({ total: dueTasks.length }, "Background task scheduler run complete");
}

function calculateNextRunTime(type: string, schedule: string | null): Date {
  const now = new Date();

  if (type === "interval" && schedule) {
    const match = schedule.match(/^(\d+)([smhd])$/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 60000;
      return new Date(now.getTime() + value * ms);
    }
  }

  if (type === "cron" && schedule) {
    // Simple cron: add 1 minute as approximate next run
    // A full cron parser would be needed for production accuracy
    return new Date(now.getTime() + 60000);
  }

  // Event-triggered: return current time (runs on trigger)
  return now;
}
