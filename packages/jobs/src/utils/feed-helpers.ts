/**
 * Feed Helpers
 *
 * Shared utility functions for feed workers.
 */

import cronParser from "cron-parser";
const { parseExpression } = cronParser;

/**
 * Calculate next run time based on cron expression.
 * Uses cron-parser for reliable parsing.
 */
export function calculateNextRun(cron: string, timezone: string): Date {
  try {
    const interval = parseExpression(cron, {
      tz: timezone,
      currentDate: new Date(),
    });
    return interval.next().toDate();
  } catch (error) {
    // Fallback: run in 1 hour if cron is invalid
    return new Date(Date.now() + 60 * 60 * 1000);
  }
}

/**
 * Check if a feed is due for execution.
 */
export function isFeedDue(nextRunAt: string | null | undefined): boolean {
  if (!nextRunAt) return true;
  return new Date(nextRunAt) <= new Date();
}
