/**
 * Google Calendar item → Synap event graph mapper (PURE function; no I/O).
 *
 * The event-sync redesign: Google Calendar events flow THROUGH Synap. Each GCal
 * item becomes a Synap `event` entity (the SAME shape event-sync's
 * `normalizeEntity` reads — startDate/endDate/calendarLink/location), so the
 * existing source-A mirror pass pushes it to a native Discord scheduled event
 * with NO direct Google→Discord path.
 *
 * TWO OUTPUTS, because the event is created two DIFFERENT ways (see run-gcal-import):
 *   - `event`         — properties for the BARE event, created DIRECTLY via
 *                       `EntityRepository.create` (R4) so it ALWAYS lands + mirrors.
 *                       (The composite door only auto-applies if EVERY op
 *                       auto-approves; a non-approvable company/deal op would
 *                       silently downgrade the whole graph to a proposal — which
 *                       would break "auto". So the event goes direct.)
 *   - `graph`         — person[] + company? + the event (as an existing ref) +
 *                       relations, for a BEST-EFFORT `submitCaptureGraph` that
 *                       resolves attendee identity and links them to the event.
 *
 * Attendee identity reuses the Cal.com mapper's proven domain helpers (email
 * dedup drives person identity; a corporate domain mints a company by website).
 */

import type {
  CaptureGraphEntity,
  CaptureGraphRelation,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";
import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "../calcom/map-booking-to-graph.js";

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
  /** { dateTime } for timed events, { date } for all-day events (or a bare ISO string). */
  start?: unknown;
  end?: unknown;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  description?: string;
  attendees?: GCalAttendee[] | null;
}

/** What the mapper hands back. */
export interface GcalGraph {
  /** Non-null only when the item has an id AND a parseable start. */
  googleEventId: string;
  /** For the DIRECT bare-event create (R4). */
  event: { title: string; properties: Record<string, unknown> };
  /** person[] + company? + the event (ref only) for the best-effort submitCaptureGraph. */
  entities: CaptureGraphEntity[];
  relations: CaptureGraphRelation[];
  /** True when the Google start had a `date` (no time) → all-day. */
  isAllDay: boolean;
}

const EVENT_REF = "event";

// event→person "attended_by" (default-relation-defs.ts) and event→company
// "relates_to" — the general graph link; the event is the anchor, not a facet.
const ATTENDED_BY = "attended_by";
const RELATES_TO = "relates_to";

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

/**
 * Map ONE Google Calendar item to a Synap event graph. Deterministic + pure.
 * Returns null when the item has no id or no parseable start (nothing to sync).
 */
export function mapGcalToGraph(item: GCalItem): GcalGraph | null {
  const googleEventId = item.id?.trim();
  const startDate = gcalTime(item.start);
  if (!googleEventId || !startDate) return null;

  const endDate = gcalTime(item.end);
  const isAllDay = isAllDayStart(item.start);
  const title = item.summary?.trim() || "(untitled event)";
  // Physical address only — a link goes in calendarLink, not location.
  const location =
    item.location && !/^https?:\/\//i.test(item.location)
      ? item.location.trim()
      : undefined;
  // Prefer the Meet link; fall back to the event's Google Calendar page.
  const calendarLink = item.hangoutLink?.trim() || item.htmlLink?.trim();

  // Attendees we can act on: has an email, isn't the pod owner (self) or a room.
  const attendees = (item.attendees ?? []).filter(
    (a) => a?.email?.trim() && !a.self && !a.resource
  );
  const attendeeSummary = attendees.map((a) => ({
    email: a.email!.trim(),
    ...(a.displayName?.trim() ? { name: a.displayName.trim() } : {}),
    ...(a.responseStatus ? { responseStatus: a.responseStatus } : {}),
  }));

  // ── Bare-event properties (event-sync/normalizeEntity shape) ────────────────
  const eventProperties: Record<string, unknown> = {
    googleEventId,
    source: "google",
    startDate,
    ...(endDate ? { endDate } : {}),
    ...(location ? { location } : {}),
    ...(calendarLink ? { calendarLink } : {}),
    ...(item.description?.trim()
      ? { description: item.description.trim() }
      : {}),
    ...(attendeeSummary.length > 0 ? { attendees: attendeeSummary } : {}),
    isAllDay,
  };

  // ── Best-effort graph: person[] + company? + the event (existing ref) ───────
  const entities: CaptureGraphEntity[] = [
    // The event as an EXISTING ref — run-gcal-import fills existingEntityId after
    // the direct create, so relations can anchor to it without re-creating it.
    { ref: EVENT_REF, profileSlug: "event", title, properties: {} },
  ];
  const relations: CaptureGraphRelation[] = [];

  const seenCompanyDomains = new Set<string>();
  attendees.forEach((a, i) => {
    const email = a.email!.trim();
    const personRef = `person_${i}`;
    const name =
      a.displayName?.trim() || email.split("@")[0] || "Unknown contact";
    entities.push({
      ref: personRef,
      profileSlug: "person",
      title: name,
      properties: { email, source: "google" },
    });
    // event attended_by person (the participant link).
    relations.push({
      sourceRef: EVENT_REF,
      targetRef: personRef,
      type: ATTENDED_BY,
    });

    // Corporate domain → company (dedup by website). One per distinct domain.
    const domain = emailDomain(email);
    if (
      isCorporateDomain(domain) &&
      domain &&
      !seenCompanyDomains.has(domain)
    ) {
      seenCompanyDomains.add(domain);
      const companyRef = `company_${domain}`;
      entities.push({
        ref: companyRef,
        profileSlug: "company",
        title: companyNameFromDomain(domain),
        properties: { website: `https://${domain}`, source: "google" },
      });
      relations.push({
        sourceRef: EVENT_REF,
        targetRef: companyRef,
        type: RELATES_TO,
      });
    }
  });

  return {
    googleEventId,
    event: { title, properties: eventProperties },
    entities,
    relations,
    isAllDay,
  };
}
