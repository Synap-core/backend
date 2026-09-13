/**
 * Entity date placement — the ONE door for "which day does this entity land on".
 *
 * `valueType: date` is overloaded on the backend: it carries both whole-DAY
 * values (a task `dueDate`, a content calendar's `publish-date` → "2026-07-25")
 * AND real timestamps that legitimately hold a time-of-day (`startTime` /
 * `endTime`). A reader must place a whole-day value on the day its author
 * meant, while leaving genuine instants exactly as they are.
 *
 * Placement chain: an optional explicit `dateField`, then
 * `properties.dueDate → startDate → startTime → date`. `createdAt` is
 * DELIBERATELY not a fallback — an entity with no real date (a person, a
 * company) is not a calendar row and must be omitted rather than pinned to the
 * day it was captured.
 *
 * This module is pure and dependency-free, so it is safe in the pod, Electron,
 * React Native and the CLI. It exists because the same six functions were
 * copied into four packages (backend ICS feed, relay, spatial-ui, the calendar
 * view) and could drift silently; those four are now re-export shims.
 */

/** Walk a dotted path (e.g. "properties.date") off an object, with a default. */
export function getProperty(
  obj: unknown,
  path: string,
  defaultValue?: unknown
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return defaultValue;
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? defaultValue : current;
}

/**
 * The RAW (unparsed) value an entity is placed by: the configured `dateField`,
 * then the conventional fallbacks. Any falsy result → null.
 */
export function resolveEntityDateValue(
  entity: unknown,
  dateField?: string
): unknown {
  let startVal = dateField ? getProperty(entity, dateField) : undefined;
  if (!startVal) {
    startVal =
      getProperty(entity, "properties.dueDate") ||
      getProperty(entity, "properties.startDate") ||
      getProperty(entity, "properties.startTime") ||
      getProperty(entity, "properties.date");
  }
  return startVal || null;
}

/**
 * A value is "date-only" when it carries no meaningful time-of-day:
 *  - a plain date string like "2026-07-25" (no `T` / time component), or
 *  - an ISO string / Date whose time is exactly 00:00:00.000.
 *
 * Such a value names a calendar DAY, not an instant. Parsing it with
 * `new Date(iso)` reads the UTC-midnight instant, which — rendered by LOCAL
 * date parts — falls on the day BEFORE for users west of UTC.
 */
export function isDateOnlyShaped(value: string | number | Date): boolean {
  if (value instanceof Date) {
    return (
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0 &&
      value.getMilliseconds() === 0
    );
  }
  if (typeof value === "string") {
    // No time part at all → date-only (e.g. "2026-07-25").
    if (!value.includes("T") && !/\d{2}:\d{2}/.test(value)) return true;
    // Has a time part — date-only only if it is exactly midnight.
    return /T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value);
  }
  // A number is an epoch instant — never date-only.
  return false;
}

/**
 * Parse a date property into a Date on the intended LOCAL day. A date-only
 * value is built from its Y-M-D parts at LOCAL midnight, so it never shifts a
 * day across the UTC boundary. Anything with a real time-of-day parses EXACTLY
 * as `new Date(value)`. Returns null for empty / unparseable input.
 */
export function parseEntityDate(
  value: string | number | Date | null | undefined
): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (isDateOnlyShaped(value)) {
    // An already-local-midnight Date is on the right day as-is.
    if (value instanceof Date) return value;
    // Pull the leading Y-M-D straight from the STRING — reading it off a parsed
    // `new Date(iso)` would already have shifted the day in a non-UTC zone.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Parsed placement date, or null when the entity carries no valid date. */
export function resolveEntityDate(
  entity: unknown,
  dateField?: string
): Date | null {
  const startVal = resolveEntityDateValue(entity, dateField);
  if (!startVal) return null;
  if (
    typeof startVal === "string" ||
    typeof startVal === "number" ||
    startVal instanceof Date
  ) {
    return parseEntityDate(startVal);
  }
  return parseEntityDate(String(startVal));
}

/**
 * True when the placement value carries a real time-of-day (a meeting), not a
 * whole-day date. An explicit `isAllDay` wins over a timed value.
 */
export function entityDateHasTime(
  raw: unknown,
  isAllDay: boolean = false
): boolean {
  if (isAllDay) return false;
  if (
    typeof raw !== "string" &&
    typeof raw !== "number" &&
    !(raw instanceof Date)
  ) {
    return false;
  }
  return !isDateOnlyShaped(raw);
}
