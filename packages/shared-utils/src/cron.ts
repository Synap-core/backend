/**
 * THE cron clock of the pod: when a cron trigger next fires, in the zone its
 * author set. One function for every door that stamps `automations.next_run_at`
 * (the automations create / update / activate door, the playbook schedule, the
 * scheduler's post-run update and its self-heal), so no two of them can read
 * the same rule at different hours.
 *
 * Built on `cron-parser`, which reads standard cron: a day-of-month and a
 * day-of-week both set match EITHER (`0 9 1 * 1` = the 1st and every Monday),
 * `a-b/N` steps, names (`MON`, `JAN`), `L` and `#`. The two hand-written
 * parsers it replaces matched the process clock, ANDed the two day fields and
 * had no `a-b/N` (ticket 592930c8: a rule set to 06:50 Europe/Paris fired at
 * 06:50 UTC, because the stored `timezone` was never read).
 */
import cronParser from "cron-parser";

const { parseExpression } = cronParser;

/** The zone of a cron trigger that names none — every row written before zones were read. */
export const DEFAULT_CRON_TIMEZONE = "UTC";

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

/**
 * Whether the cron clock can read `timezone` — asked of the clock itself, so
 * the door and the scheduler agree. `local` / `system` are refused: they name
 * the worker's own clock, the very zone nobody chose.
 */
export function isCronTimezone(timezone: string): boolean {
  if (/^(local|system)$/i.test(timezone.trim())) return false;
  return nextCronRunAt("* * * * *", new Date(0), timezone) !== null;
}
