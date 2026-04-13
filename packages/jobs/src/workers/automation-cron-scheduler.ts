/**
 * Automation Cron Scheduler Worker
 *
 * Polls active cron-triggered automations every minute.
 * When nextRunAt <= now(), creates an automation_runs record
 * and enqueues an automation-execute job.
 *
 * Separate from background-task-scheduler — automations are DAGs,
 * background_tasks are flat single-action schedulers.
 */

import { db, eq, and, lte, automations, automationRuns } from "@synap/database";
import { drizzleSql } from "@synap/database";
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "automation-cron-scheduler" });

/**
 * Parse a 5-field cron expression and compute the next run time from a given base.
 * Supports: minute hour dayOfMonth month dayOfWeek
 *
 * Simple forward-scan implementation — checks the next 1440 minutes (24h)
 * to find the next matching slot.
 */
function computeNextRunAt(cronExpr: string, fromDate: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;

  function matchesCronField(
    field: string,
    value: number,
    _max: number
  ): boolean {
    if (field === "*") return true;

    // Handle */N step
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }

    // Handle comma-separated values
    const values = field.split(",");
    for (const v of values) {
      // Handle range N-M
      if (v.includes("-")) {
        const [start, end] = v.split("-").map(Number);
        if (value >= start && value <= end) return true;
        continue;
      }
      // Handle day-of-week names
      const dayNames: Record<string, number> = {
        SUN: 0,
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
      };
      const resolved = dayNames[v.toUpperCase()] ?? parseInt(v, 10);
      if (resolved === value) return true;
    }
    return false;
  }

  // Scan forward minute-by-minute for up to 366 days
  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // Start from next minute

  const maxAttempts = 366 * 24 * 60; // One year of minutes
  for (let i = 0; i < maxAttempts; i++) {
    const min = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1; // 1-indexed
    const dow = candidate.getDay(); // 0=Sun

    if (
      matchesCronField(minExpr, min, 59) &&
      matchesCronField(hourExpr, hour, 23) &&
      matchesCronField(domExpr, dom, 31) &&
      matchesCronField(monthExpr, month, 12) &&
      matchesCronField(dowExpr, dow, 6)
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Main handler: runs every minute via pg-boss cron schedule.
 * Finds active cron automations due for execution and triggers them.
 */
export async function handleAutomationCronScheduler(): Promise<void> {
  const now = new Date();

  // Find active cron automations where nextRunAt <= now
  const dueAutomations = await db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.status, "active"),
        eq(automations.triggerType, "cron"),
        lte(automations.nextRunAt, now)
      )
    );

  if (dueAutomations.length === 0) return;

  logger.info({ count: dueAutomations.length }, "Found due cron automations");

  const boss = getBoss();

  for (const automation of dueAutomations) {
    try {
      const triggerConfig = automation.triggerConfig as Record<string, unknown>;
      const cronExpression = triggerConfig?.expression as string;

      // Create run record
      const [run] = await db
        .insert(automationRuns)
        .values({
          automationId: automation.id,
          workspaceId: automation.workspaceId,
          status: "running",
          triggerPayload: {
            type: "cron",
            expression: cronExpression,
            scheduledAt: now.toISOString(),
          },
        })
        .returning({ id: automationRuns.id });

      if (!run) continue;

      // Enqueue execution
      await boss.send("automation-execute", {
        runId: run.id,
        automationId: automation.id,
        workspaceId: automation.workspaceId,
        automationContext: {
          automationRunId: run.id,
          automationId: automation.id,
          chainDepth: 0,
          rootRunId: run.id,
          chainAutomationIds: [automation.id],
        },
      });

      // Compute and set next run time
      const nextRunAt = cronExpression
        ? computeNextRunAt(cronExpression, now)
        : null;

      await db
        .update(automations)
        .set({
          lastRunAt: now,
          nextRunAt,
          runCount: drizzleSql`COALESCE(${automations.runCount}, 0) + 1`,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, automation.id));

      logger.info(
        {
          automationId: automation.id,
          runId: run.id,
          nextRunAt: nextRunAt?.toISOString(),
        },
        "Cron automation triggered"
      );
    } catch (err) {
      logger.error(
        { err, automationId: automation.id },
        "Failed to trigger cron automation"
      );
    }
  }
}

// Export computeNextRunAt for use by the activate procedure
export { computeNextRunAt };
