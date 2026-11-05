/**
 * "Later" on a request (founder decision G3, 30 Oct 2026): one person sets a
 * pending request aside until a time. Nothing about governance changes and
 * nobody else is affected; the request comes back on its own at that time.
 *
 * The pod door (`proposals.later`) takes the time itself and refuses one in
 * the past or more than {@link REQUEST_LATER_MAX_MS} ahead. The CHOICES a
 * surface offers are derived here, once, in the person's own clock (the
 * device's local time), so pod admin and the phone offer the same three.
 */

/** The longest a request can be set aside: 30 days. */
export const REQUEST_LATER_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Why `until` is not a time Later may set aside `what` until, or null when it
 * is: the ONE check both Later doors apply (a request's, `proposals.later`;
 * an owed ask's, `focusSessions.askLater`), its day count read from
 * {@link REQUEST_LATER_MAX_MS} so the words cannot drift from the limit.
 */
export function laterTimeProblem(
  until: Date,
  now: Date,
  what: "a request" | "an ask"
): string | null {
  const at = until.getTime();
  if (!Number.isFinite(at) || at <= now.getTime()) {
    return "Later needs a time in the future.";
  }
  if (at > now.getTime() + REQUEST_LATER_MAX_MS) {
    const days = Math.round(REQUEST_LATER_MAX_MS / (24 * 60 * 60 * 1000));
    return `Later can set ${what} aside for ${days} days at most.`;
  }
  return null;
}

/** The times a surface offers, in this order. */
export const REQUEST_LATER_CHOICES = [
  "in_3_hours",
  "tomorrow",
  "next_week",
] as const;
export type RequestLaterChoice = (typeof REQUEST_LATER_CHOICES)[number];

/** The morning hour "tomorrow" and "next week" come back at, local time. */
const MORNING_HOUR = 8;

/**
 * The time a choice means, from `now`, in the local time of the device that
 * calls it: in 3 hours; tomorrow at 8:00; next Monday at 8:00 (a week from
 * today when today is Monday).
 */
export function requestLaterUntil(
  choice: RequestLaterChoice,
  now: Date = new Date()
): Date {
  if (choice === "in_3_hours") {
    return new Date(now.getTime() + 3 * 60 * 60 * 1000);
  }
  const at = new Date(now);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  if (choice === "tomorrow") {
    at.setDate(at.getDate() + 1);
    return at;
  }
  const toMonday = (8 - at.getDay()) % 7 || 7;
  at.setDate(at.getDate() + toMonday);
  return at;
}
