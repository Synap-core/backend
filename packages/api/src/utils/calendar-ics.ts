/**
 * Hand-rolled ICS calendar feed (no extra npm dep).
 *
 * Date placement (`dueDate → startDate → startTime → date`; never `createdAt`)
 * and the date-only local-day parser live in `@synap-core/types/dates` — the
 * ONE door, shared with relay, spatial-ui and the calendar view. They are
 * re-exported here so the existing import sites keep working; do NOT re-inline
 * a local copy, that is exactly the drift this package removed.
 */

import {
  getProperty,
  resolveEntityDateValue,
  isDateOnlyShaped,
  parseEntityDate,
  resolveEntityDate,
  entityDateHasTime,
} from "@synap-core/types/dates";

export {
  getProperty,
  resolveEntityDateValue,
  isDateOnlyShaped,
  parseEntityDate,
  resolveEntityDate,
  entityDateHasTime,
};

export const CALENDAR_PROFILE_SLUGS = ["task", "event", "meeting"] as const;

export interface CalendarFeedEntity {
  id: string;
  title?: string | null;
  preview?: string | null;
  properties?: Record<string, unknown> | null;
  type?: string | null;
  profileSlug?: string | null;
  updatedAt?: Date | string | null;
}

function profileOf(entity: CalendarFeedEntity): string {
  return (entity.profileSlug || entity.type || "").toLowerCase();
}

/**
 * A task that no longer wants doing — it must leave the calendar.
 *
 * Mirrors relay's `isOpenStatus` (`relay-app/src/lib/task-model.ts`): open is
 * `todo`, `in-progress`, or ABSENT — an unknown or missing status is open,
 * because a task nobody has finished is not finished. Everything else (done,
 * cancelled) is closed.
 *
 * This used to filter `cancelled` only, which meant every task you ever ticked
 * stayed in Apple Calendar forever — and the feed is read-only, so the user
 * could not delete them. It also disagreed with the phone: relay's Week screen
 * drops done tasks, so "my week" meant two different sets on two screens.
 *
 * Events and meetings are never filtered by status: a meeting that happened is
 * still a thing that happened, and a calendar is a record of it.
 */
export function isClosedTask(entity: CalendarFeedEntity): boolean {
  if (profileOf(entity) !== "task") return false;
  const status = entity.properties?.status;
  if (typeof status !== "string") return false;
  const n = status.trim().toLowerCase();
  return n !== "todo" && n !== "in-progress" && n !== "in_progress" && n !== "";
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
  lastModified?: string;
  sequence: number;
}

/**
 * SEQUENCE epoch — 2020-01-01T00:00:00Z, in ms.
 *
 * RFC 5545 §3.8.7.4 SEQUENCE is an INTEGER, and §3.3.8 caps that at
 * 2147483647. Seconds-since-1970 is already 1.7e9 and overflows in 2038, so
 * the counter is rebased on a recent epoch: today it is ~2.1e8 and grows
 * ~3.2e7/year, which leaves the range good for ~60 more years.
 */
const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);

/**
 * A monotonic revision number for one item, derived from `updatedAt`.
 *
 * Some clients only re-render an already-known UID when SEQUENCE INCREASES —
 * LAST-MODIFIED alone is advisory. There is no revision column and we do not
 * want one: `updatedAt` already moves on every write, which is exactly the
 * event SEQUENCE is meant to signal.
 *
 * Granularity is one second. Two edits inside the same second share a
 * SEQUENCE; LAST-MODIFIED and the changed body still differ, so the worst case
 * is a client that redraws lazily, never a wrong value.
 */
export function icsSequence(updated: Date | null): number {
  if (!updated) return 0;
  const secs = Math.floor((updated.getTime() - SEQUENCE_EPOCH_MS) / 1000);
  return secs > 0 ? secs : 0;
}

export function entityToVEvent(
  entity: CalendarFeedEntity,
  uidNamespace: string
): VEventInput | null {
  if (isClosedTask(entity)) return null;
  const raw = resolveEntityDateValue(entity);
  const start = resolveEntityDate(entity);
  if (!start || !raw) return null;

  const props = asRecord(entity.properties);
  const allDay = props.isAllDay === true || !entityDateHasTime(raw, false);
  const uid = `${entity.id}@${uidNamespace}`;
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
  // DESCRIPTION is `properties.description` ONLY.
  //
  // `entity.preview` is the entity BODY excerpt — the first lines of whatever
  // the user wrote inside the object. That is note content, not a calendar
  // field, and this feed is served over an unauthenticated URL that syncs to a
  // phone, a laptop and any device the calendar account touches. Putting the
  // body in the event pushed private prose somewhere the user never chose.
  const description =
    typeof props.description === "string" && props.description.trim()
      ? props.description.trim()
      : undefined;
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
    sequence: icsSequence(updated),
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
  lines.push(`SEQUENCE:${event.sequence}`);
  if (event.lastModified) lines.push(`LAST-MODIFIED:${event.lastModified}`);
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * Polling cadence we SUGGEST to clients. A hint, and nothing more.
 *
 * RFC 7986 §5.7 calls REFRESH-INTERVAL a suggested MINIMUM, not a contract;
 * `X-PUBLISHED-TTL` is Microsoft's older spelling of the same suggestion.
 * Apple's Calendar appears to ignore both (it keeps its own per-subscription
 * "Refresh" setting), and Google documents neither and exposes no server-side
 * influence over its poll rate. They are emitted because they are two correct
 * lines that some clients do read — not because they control anything.
 */
export const FEED_REFRESH_HINT = "PT1H";

export function buildIcsCalendar(
  events: VEventInput[],
  opts?: { calName?: string; entityUrl?: (uid: string) => string | undefined }
): string {
  // X-WR-CALNAME is what Apple/Google actually name the subscription with;
  // without it Apple names it after the URL, putting the feed SECRET in the
  // sidebar. RFC 7986 §5.1 NAME is the standard spelling of the same thing —
  // both are emitted, with the same value, so no client has to guess.
  const calName = escapeIcsText(opts?.calName ?? "Synap");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Synap//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${calName}`,
    `NAME:${calName}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${FEED_REFRESH_HINT}`,
    `X-PUBLISHED-TTL:${FEED_REFRESH_HINT}`,
  ];
  for (const event of events) {
    const uidEntityId = event.uid.split("@")[0] ?? "";
    lines.push(...veventLines(event, opts?.entityUrl?.(uidEntityId)));
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * How far either side of "now" the feed reaches.
 *
 * A subscribed client re-fetches the WHOLE body every poll — there is no
 * incremental sync in ICS — so an unwindowed feed grows without bound and is
 * re-serialized ~96x/day per client. Backwards is short (a calendar is for
 * what is coming; last year's tasks are history you read in the app), forwards
 * is a year so a dated commitment never silently drops off the end.
 */
export const FEED_WINDOW_DAYS_BACK = 30;
export const FEED_WINDOW_DAYS_AHEAD = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Is `start` inside the feed window around `now`? */
export function isWithinFeedWindow(start: Date, now: Date): boolean {
  const from = now.getTime() - FEED_WINDOW_DAYS_BACK * DAY_MS;
  const to = now.getTime() + FEED_WINDOW_DAYS_AHEAD * DAY_MS;
  const at = start.getTime();
  return at >= from && at <= to;
}

/**
 * Filter closed/undated/out-of-window entities and serialize a METHOD:PUBLISH
 * calendar.
 *
 * `now` is INJECTED rather than read from the clock so the window is
 * deterministic under test — the same reason the automation evaluator takes it.
 */
export function buildSynapCalendarIcs(
  entities: CalendarFeedEntity[],
  uidNamespace: string,
  opts?: {
    entityUrl?: (id: string) => string | undefined;
    now?: Date;
  }
): { ics: string; events: VEventInput[]; maxUpdatedAt: Date | null } {
  const events: VEventInput[] = [];
  const now = opts?.now ?? new Date();
  let maxUpdatedAt: Date | null = null;
  for (const entity of entities) {
    const start = resolveEntityDate(entity);
    if (!start || !isWithinFeedWindow(start, now)) continue;
    const vevent = entityToVEvent(entity, uidNamespace);
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
