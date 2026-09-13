/**
 * Google Calendar item → sync graph mapper (PURE function; no I/O).
 *
 * Each GCal item becomes a Synap `event` entity (the SAME shape event-sync's
 * `normalizeEntity` reads — startDate/endDate/calendarLink/location), so the
 * source-A mirror pass pushes it to a native Discord scheduled event with NO
 * direct Google→Discord path. Attendees become people (email identity) and, for
 * a corporate domain, a company — through the shared `participantsGraph`, so a
 * person met on an event and later emailed is the SAME ref in one run.
 *
 * The event's upsert identity is `(google, <googleEventId>)` — byte-compatible
 * with the external links the previous per-event importer registered, so an
 * event imported before this door still matches exactly. Its `url` is the
 * event's `htmlLink` from the API response (never constructed).
 */

import {
  mergeSyncGraph,
  participantsGraph,
  emptySyncGraph,
  RELATION_ATTENDED_BY,
  RELATION_RELATES_TO,
  type SyncGraph,
} from "./sync-graph.js";

export const GOOGLE_PROVIDER = "google";

// ── Google Calendar `events.list` item (fields we consume) ─────────────────────
export interface GCalAttendee {
  email?: string;
  displayName?: string;
  /** Google flags the calendar owner's own attendee row. We skip it (would mint a person for the pod owner). */
  self?: boolean;
  /** Meeting rooms / equipment are resources, not people. */
  resource?: boolean;
  organizer?: boolean;
  responseStatus?: string;
}

export interface GCalItem {
  id?: string;
  summary?: string;
  /** "confirmed" | "tentative" | "cancelled". */
  status?: string;
  /** { dateTime } for timed events, { date } for all-day events (or a bare ISO string). */
  start?: unknown;
  end?: unknown;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  description?: string;
  attendees?: GCalAttendee[] | null;
}

export interface GcalGraph {
  googleEventId: string;
  /** The event's ref inside `graph`. */
  eventRef: string;
  graph: SyncGraph;
  /** True when the Google start had a `date` (no time) → all-day. */
  isAllDay: boolean;
}

/** Extract an ISO time from a Google Calendar start/end field. */
export function gcalTime(t: unknown): string | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return t.trim() || undefined;
  const obj = t as { dateTime?: string; date?: string };
  return obj.dateTime?.trim() || obj.date?.trim() || undefined;
}

/** A Google start is all-day when it carries a `date` and no `dateTime`. */
export function isAllDayStart(t: unknown): boolean {
  if (!t || typeof t === "string") return false;
  const obj = t as { dateTime?: string; date?: string };
  return !obj.dateTime && !!obj.date;
}

/**
 * Layer-2 cross-source dedup key half: the title, normalized (lowercased, trimmed,
 * inner whitespace collapsed). Paired with a start-time bucket so that recurring
 * SAME-TITLE events (which the weak identity path would wrongly collapse) stay
 * DISTINCT — the bucket differs per occurrence.
 */
export function normalizeEventTitle(title: string | null | undefined): string {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Layer-2 dedup key half: the start-time bucket as a `[gte, lt)` ISO window.
 * Timed events truncate to the HOUR; all-day events (Google `start.date`, no
 * time) truncate to the DAY — an all-day event has no meaningful hour, so an
 * hour bucket would fragment it. Returns null when the start is unparseable.
 */
export function startBucketWindow(
  startDate: string,
  isAllDay: boolean
): { gte: string; lt: string } | null {
  const ms = Date.parse(startDate);
  if (Number.isNaN(ms)) return null;
  const span = isAllDay ? 24 * 3_600_000 : 3_600_000;
  const floor = Math.floor(ms / span) * span;
  return {
    gte: new Date(floor).toISOString(),
    lt: new Date(floor + span).toISOString(),
  };
}

export function eventRef(googleEventId: string): string {
  return `event:${googleEventId}`;
}

/**
 * Map ONE Google Calendar item to a sync graph. Deterministic + pure.
 * Returns null when the item has no id, no parseable start, or is cancelled
 * (nothing to mirror).
 */
export function mapGcalToGraph(item: GCalItem): GcalGraph | null {
  const googleEventId = item.id?.trim();
  const startDate = gcalTime(item.start);
  if (!googleEventId || !startDate) return null;
  if (item.status === "cancelled") return null;

  const endDate = gcalTime(item.end);
  const isAllDay = isAllDayStart(item.start);
  const title = item.summary?.trim() || "(untitled event)";
  // Physical address only — a link goes in calendarLink, not location.
  const location =
    item.location && !/^https?:\/\//i.test(item.location)
      ? item.location.trim()
      : undefined;
  // Prefer the Meet link; fall back to the event's Google Calendar page.
  const htmlLink = item.htmlLink?.trim() || undefined;
  const calendarLink = item.hangoutLink?.trim() || htmlLink;

  // Attendees we can act on: has an email, isn't the pod owner (self) or a room.
  const attendees = (item.attendees ?? []).filter(
    (a) => a?.email?.trim() && !a.self && !a.resource
  );
  const attendeeSummary = attendees.map((a) => ({
    email: a.email!.trim(),
    ...(a.displayName?.trim() ? { name: a.displayName.trim() } : {}),
    ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
  }));

  const ref = eventRef(googleEventId);
  const graph = emptySyncGraph();
  graph.entities.push({
    ref,
    profileSlug: "event",
    title,
    properties: {
      googleEventId,
      source: GOOGLE_PROVIDER,
      startDate,
      ...(endDate ? { endDate } : {}),
      ...(location ? { location } : {}),
      ...(calendarLink ? { calendarLink } : {}),
      ...(item.description?.trim()
        ? { description: item.description.trim() }
        : {}),
      ...(attendeeSummary.length > 0 ? { attendees: attendeeSummary } : {}),
      isAllDay,
    },
    identity: {
      source: GOOGLE_PROVIDER,
      externalId: googleEventId,
      url: htmlLink ?? null,
    },
  });

  mergeSyncGraph(
    graph,
    participantsGraph(
      attendees.map((a) => ({
        email: a.email!.trim(),
        ...(a.displayName?.trim() ? { name: a.displayName.trim() } : {}),
      })),
      {
        ref,
        personRelation: RELATION_ATTENDED_BY,
        companyRelation: RELATION_RELATES_TO,
      }
    )
  );

  return { googleEventId, eventRef: ref, graph, isAllDay };
}
