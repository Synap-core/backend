/**
 * What makes two events the SAME event (founder, 2026-10-28): the same title AND
 * the same start. A title alone is not an event's identity — a recurring "Laver
 * ses cheveux" is 26 different events, one per date — so a same-title event on
 * another date is never a twin.
 *
 * ONE rule, read by the duplicate door (`find-duplicate-candidates.ts`) and the
 * connection sync's in-graph fold (`event-sync/sync-graph.ts`). Pure.
 */

/** The kind whose identity is title + start. */
export const EVENT_KIND = "event";

/** An event's start, as identity: the instant, and whether only its day counts. */
export interface EventStart {
  ms: number;
  /** An all-day event (Google `start.date`) has a day, not a time. */
  allDay: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3_600_000;

/** An event's title as identity compares it: trimmed, spaces collapsed, case-folded. */
export function eventTitleKey(title: string | null | undefined): string {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The start an event's properties carry, or null when it has none parseable. */
export function eventStartOf(
  properties: Record<string, unknown> | null | undefined
): EventStart | null {
  const raw = properties?.startDate;
  if (typeof raw !== "string") return null;
  const startDate = raw.trim();
  const ms = Date.parse(startDate);
  if (Number.isNaN(ms)) return null;
  const isAllDay = properties?.isAllDay;
  return {
    ms,
    allDay:
      isAllDay === true || isAllDay === "true" || DATE_ONLY.test(startDate),
  };
}

/**
 * Same start: the same UTC day when either side is all-day (it has no time to
 * compare), the same minute otherwise. Offsets do not matter: the instant does.
 */
export function sameEventStart(a: EventStart, b: EventStart): boolean {
  const span = a.allDay || b.allDay ? DAY_MS : MINUTE_MS;
  return Math.floor(a.ms / span) === Math.floor(b.ms / span);
}
