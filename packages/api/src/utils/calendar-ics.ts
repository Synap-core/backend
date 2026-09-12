/**
 * Hand-rolled ICS calendar feed (no extra npm dep).
 *
 * Date placement copies the calendar-view fallback
 * (`dueDate → startDate → startTime → date`; never `createdAt`) and the
 * date-only local-day parser. Copied rather than imported: calendar-view
 * pulls Svelte.
 */

export const CALENDAR_PROFILE_SLUGS = ["task", "event", "meeting"] as const;
export type CalendarProfileSlug = (typeof CALENDAR_PROFILE_SLUGS)[number];

export interface CalendarFeedEntity {
  id: string;
  title?: string | null;
  preview?: string | null;
  properties?: Record<string, unknown> | null;
  type?: string | null;
  profileSlug?: string | null;
  updatedAt?: Date | string | null;
}

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
 * RAW placement value: optional `dateField`, then dueDate → startDate →
 * startTime → date. Falsy → null. `createdAt` is not a fallback.
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

/** Date-only: plain Y-M-D, or an ISO / Date whose time is exactly 00:00:00.000. */
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
    if (!value.includes("T") && !/\d{2}:\d{2}/.test(value)) return true;
    return /T00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value);
  }
  return false;
}

/**
 * Parse a date property onto the intended LOCAL day. Date-only values land
 * at local midnight so they never shift a day west of UTC.
 */
export function parseEntityDate(
  value: string | number | Date | null | undefined
): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (isDateOnlyShaped(value)) {
    if (value instanceof Date) return value;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

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

function profileOf(entity: CalendarFeedEntity): string {
  return (entity.profileSlug || entity.type || "").toLowerCase();
}

/** Cancelled tasks are omitted from the feed. Events/meetings are not. */
export function isCancelledTask(entity: CalendarFeedEntity): boolean {
  if (profileOf(entity) !== "task") return false;
  const status = entity.properties?.status;
  if (typeof status !== "string") return false;
  const n = status.trim().toLowerCase();
  return n === "cancelled" || n === "canceled";
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** RFC 5545 line fold at 75 octets. Continuation lines start with a space. */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === offset) end = Math.min(offset + limit, bytes.length);
    parts.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local Y-M-D as ICS DATE (no UTC conversion). */
export function formatIcsDateOnly(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** Instant as ICS UTC timestamp. */
export function formatIcsUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

function addOneLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function asRecord(
  properties: CalendarFeedEntity["properties"]
): Record<string, unknown> {
  return properties && typeof properties === "object" ? properties : {};
}

export interface VEventInput {
  uid: string;
  dtstamp: string;
  dtstartLine: string;
  dtendLine?: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  lastModified?: string;
}

export function entityToVEvent(
  entity: CalendarFeedEntity,
  podHost: string
): VEventInput | null {
  if (isCancelledTask(entity)) return null;
  const raw = resolveEntityDateValue(entity);
  const start = resolveEntityDate(entity);
  if (!start || !raw) return null;

  const props = asRecord(entity.properties);
  const allDay = props.isAllDay === true || !entityDateHasTime(raw, false);
  const uid = `${entity.id}@${podHost}`;
  const updated =
    entity.updatedAt != null
      ? parseEntityDate(entity.updatedAt as never)
      : null;
  const dtstamp = formatIcsUtc(updated ?? new Date(0));

  let dtstartLine: string;
  let dtendLine: string | undefined;
  if (allDay) {
    dtstartLine = `DTSTART;VALUE=DATE:${formatIcsDateOnly(start)}`;
    // RFC 5545 DATE DTEND is exclusive.
    dtendLine = `DTEND;VALUE=DATE:${formatIcsDateOnly(addOneLocalDay(start))}`;
  } else {
    dtstartLine = `DTSTART:${formatIcsUtc(start)}`;
    const endRaw = props.endTime || props.endDate;
    const endParsed = endRaw ? parseEntityDate(endRaw as never) : null;
    if (endParsed && entityDateHasTime(endRaw)) {
      dtendLine = `DTEND:${formatIcsUtc(endParsed)}`;
    }
  }

  const summary =
    typeof entity.title === "string" && entity.title.trim()
      ? entity.title.trim()
      : "Untitled";
  const description =
    (typeof entity.preview === "string" && entity.preview.trim()) ||
    (typeof props.description === "string" && props.description.trim()) ||
    undefined;
  const location =
    typeof props.location === "string" && props.location.trim()
      ? props.location.trim()
      : undefined;

  return {
    uid,
    dtstamp,
    dtstartLine,
    dtendLine,
    summary,
    description: description || undefined,
    location,
    lastModified: updated ? formatIcsUtc(updated) : undefined,
  };
}

export function veventLines(event: VEventInput, url?: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${event.dtstamp}`,
    event.dtstartLine,
  ];
  if (event.dtendLine) lines.push(event.dtendLine);
  if (event.lastModified) lines.push(`LAST-MODIFIED:${event.lastModified}`);
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  const href = url ?? event.url;
  if (href) lines.push(`URL:${href}`);
  lines.push("END:VEVENT");
  return lines;
}

export function buildIcsCalendar(
  events: VEventInput[],
  opts?: { calName?: string; entityUrl?: (uid: string) => string | undefined }
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Synap//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(opts?.calName ?? "Synap")}`,
  ];
  for (const event of events) {
    const uidEntityId = event.uid.split("@")[0] ?? "";
    const url = opts?.entityUrl?.(uidEntityId);
    lines.push(...veventLines(event, url ?? event.url));
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * Filter cancelled/undated entities and serialize a METHOD:PUBLISH calendar.
 */
export function buildSynapCalendarIcs(
  entities: CalendarFeedEntity[],
  podHost: string,
  opts?: { entityUrl?: (id: string) => string | undefined }
): { ics: string; events: VEventInput[]; maxUpdatedAt: Date | null } {
  const events: VEventInput[] = [];
  let maxUpdatedAt: Date | null = null;
  for (const entity of entities) {
    const vevent = entityToVEvent(entity, podHost);
    if (!vevent) continue;
    events.push(vevent);
    const updated =
      entity.updatedAt != null
        ? parseEntityDate(entity.updatedAt as never)
        : null;
    if (updated && (!maxUpdatedAt || updated > maxUpdatedAt)) {
      maxUpdatedAt = updated;
    }
  }
  return {
    ics: buildIcsCalendar(events, {
      calName: "Synap",
      entityUrl: opts?.entityUrl,
    }),
    events,
    maxUpdatedAt,
  };
}
