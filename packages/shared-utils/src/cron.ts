/**
 * THE cron clock of the pod: when a cron trigger next fires, in the zone its
 * author set (standard cron via `cron-parser`: day-of-month and day-of-week both
 * set match EITHER). Every door that stamps `automations.next_run_at` reads it.
 */
import cronParser from "cron-parser";

const { parseExpression } = cronParser;

/** The zone of a cron trigger that names none — every row written before zones were read. */
const DEFAULT_CRON_TIMEZONE = "UTC";

/**
 * The next moment after `from` that `expression` matches, read in `timezone`
 * (an IANA name; absent = UTC). Null when it cannot be scheduled: not five
 * fields (minute hour day-of-month month day-of-week), a field cron cannot
 * read, or a zone the clock does not know.
 */
export function nextCronRunAt(
  expression: string,
  from: Date,
  timezone?: string | null
): Date | null {
  const normalized = expression.trim();
  if (normalized.split(/\s+/).length !== 5) return null;
  try {
    return parseExpression(normalized, {
      currentDate: from,
      tz: timezone || DEFAULT_CRON_TIMEZONE,
    })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

/** The next slot of a stored cron `triggerConfig` (`expression`, `timezone`); null without one. */
export function nextCronRunAtFor(
  triggerConfig: unknown,
  from: Date
): Date | null {
  const config = (triggerConfig ?? {}) as Record<string, unknown>;
  return typeof config.expression === "string"
    ? nextCronRunAt(
        config.expression,
        from,
        typeof config.timezone === "string" ? config.timezone : undefined
      )
    : null;
}

/**
 * Whether the cron clock can read `timezone` — asked of the clock itself, so
 * the door and the scheduler agree. `local` / `system` are refused: they name
 * the worker's own clock, the very zone nobody chose.
 */
export function isCronTimezone(timezone: string): boolean {
  if (/^(local|system)$/i.test(timezone.trim())) return false;
  return nextCronRunAt("* * * * *", new Date(0), timezone) !== null;
}
