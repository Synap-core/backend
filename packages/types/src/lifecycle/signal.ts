/**
 * STATUS SIGNALS (status-flow plan W6) — what the hourly watcher notices about
 * a thing that stands still, and raises once per episode as the derived event
 * `<subjectType>.signal.completed`:
 *
 *   stuck            — longer in its step than the step's `stuckAfterDays`;
 *   late             — the date its step is bound to (`dateBinding`) passed;
 *   approaching      — that date is at most {@link DATE_APPROACHING_DAYS} ahead;
 *   hold_review_due  — its pause's `reviewBy` passed and it is still paused.
 *
 * Calendar time only (plan Q3.1): no business days, no time zones beyond UTC.
 * Pure: no imports at run time.
 */

export const STATUS_SIGNALS = [
  "stuck",
  "late",
  "approaching",
  "hold_review_due",
] as const;
export type StatusSignal = (typeof STATUS_SIGNALS)[number];

/** "Approaching": the bound date is due within this many days. One default. */
export const DATE_APPROACHING_DAYS = 3;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When a bound date falls DUE, in ms: a date-only value (`2026-10-20`) at the
 * END of that day (UTC), so a thing due on the 20th is late from the 21st; a
 * timestamp at that instant. `null` when the value is not a date.
 */
export function dateDueAt(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  const at = Date.parse(DATE_ONLY.test(v) ? `${v}T00:00:00.000Z` : v);
  if (!Number.isFinite(at)) return null;
  return DATE_ONLY.test(v) ? at + DAY_MS : at;
}

/**
 * The date signal of a thing standing in a step bound to `value`: late once it
 * is due, approaching within {@link DATE_APPROACHING_DAYS} before, else null.
 * `beganAt` = when that state began (ISO): the due moment, or the start of
 * the approaching window.
 */
export function dateSignalOf(
  value: unknown,
  now: number = Date.now()
): {
  signal: "late" | "approaching";
  dueAt: string;
  beganAt: string;
} | null {
  const due = dateDueAt(value);
  if (due === null) return null;
  const dueAt = new Date(due).toISOString();
  if (due <= now) return { signal: "late", dueAt, beganAt: dueAt };
  const windowMs = DATE_APPROACHING_DAYS * DAY_MS;
  if (due - now <= windowMs) {
    return {
      signal: "approaching",
      dueAt,
      beganAt: new Date(due - windowMs).toISOString(),
    };
  }
  return null;
}
