/**
 * Cal.com booking → CRM graph mapper (PURE function; no I/O).
 *
 * A booked call is a LEAD, not a deal (W15, 2026-10-11): a deal is created only
 * at hand-off, when a lead is won. So a BOOKING_CREATED becomes:
 *   person(attendee, email→identity) wearing the `lead` role at
 *   `leadStage: engaged` + company(corporate domain only, person `works_at` it)
 *   + event(startDate/endDate/calendarLink) `attended_by` the person, so the
 *   call sits on the lead's agenda.
 *
 * The lead role is attached with `advanceExisting`: a person who is not a lead
 * yet becomes one at `engaged`; a lead at an earlier stage (new, researching,
 * outreach) moves forward through the facet door; a lead already at or past
 * `engaged` (qualified, nurturing, converted, disqualified) keeps its stage —
 * the booking then only records the event.
 *
 * The `event` entity is shaped for event-sync's `normalizeEntity`
 * (startDate/endDate/calendarLink) so the same booking mirrors to a native
 * Discord scheduled event with NO dependency on Google Calendar.
 *
 * With `options.attribution`, the booking also writes its `attribution-event`
 * (eventtype "booking", source/medium/campaign from the booker's hidden UTM
 * answers, else cal.com / booking / (none)) `relates_to` the person — in the
 * SAME graph, so it lands, proposes and dedupes with the booking.
 *
 * Output plugs straight into `submitCaptureGraph({ entities, relations })` — the
 * shared `/api/hub/capture/graph` door (within-batch dedup + email identity
 * resolution live there; we do NOT hand-roll an entity writer).
 */

import type {
  CaptureGraphEntity,
  CaptureGraphRelation,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";
import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "../../utils/email-domain.js";
import {
  RELATION_ATTENDED_BY,
  RELATION_RELATES_TO,
  RELATION_WORKS_AT,
} from "../event-sync/sync-graph.js";

// ── Cal.com webhook / bookings-list payload (fields we consume) ────────────────
export interface CalBookingPayload {
  uid?: string;
  title?: string;
  /** RFC3339 — webhook uses startTime/endTime; the bookings list uses start/end. */
  startTime?: string;
  endTime?: string;
  start?: string;
  end?: string;
  location?: string;
  status?: string;
  /** Meet/video link when the booking is a video call. */
  videoCallData?: { url?: string } | null;
  meetingUrl?: string;
  attendees?: Array<{
    name?: string;
    email?: string;
    timeZone?: string;
  }> | null;
  /** When the booking was made (the bookings list carries it; the webhook
   *  envelope carries its own `createdAt` instead). */
  createdAt?: string;
  eventTypeId?: number | null;
  /** Webhook: `bookingId`; bookings list: `id`. */
  bookingId?: number | null;
  id?: number | null;
  /**
   * The booker's answers, one per booking question, keyed by the question's
   * identifier. Webhook (`CalendarEvent.responses`, `CalEventResponses`):
   * `{ label, value, isHidden? }`. Bookings list (v2): a flat
   * `bookingFieldsResponses` of plain values. A HIDDEN question named
   * `utm_source` (etc.) is how a booking page carries UTMs to the webhook:
   * Cal.com tracks the standard UTMs itself but its webhook payload has no
   * tracking field (packages/features/webhooks/lib/sendPayload.ts,
   * packages/types/Calendar.d.ts, checked 26 Nov 2026).
   */
  responses?: Record<string, unknown> | null;
  userFieldsResponses?: Record<string, unknown> | null;
  bookingFieldsResponses?: Record<string, unknown> | null;
  /** Booking metadata (`metadata[key]=value` on the booking link). */
  metadata?: Record<string, unknown> | null;
  /**
   * A UTM object, when the payload carries one (`tracking` is where a Cal.com
   * booking keeps its page's UTMs; `utm` / `utmParams` are read the same
   * way). Keyed `utm_source` or bare `source` alike.
   */
  tracking?: Record<string, unknown> | null;
  utm?: Record<string, unknown> | null;
  utmParams?: Record<string, unknown> | null;
}

export interface BookingGraph {
  entities: CaptureGraphEntity[];
  relations: CaptureGraphRelation[];
}

/** The lead role and the stage a booked call puts it at (foundation `leadStage`). */
export const BOOKING_LEAD_ROLE = "lead";
export const BOOKING_LEAD_STAGE = "engaged";

/**
 * The `attribution-event` a booking writes (founder, 26 Nov 2026): one per
 * BOOKING_CREATED, linked to the person, so a booked call counts as a
 * conversion of the campaign that brought it. Its kind's required fields are
 * source, medium, campaign, timestamp and eventtype.
 */
export const BOOKING_ATTRIBUTION_KIND = "attribution-event";
export const BOOKING_ATTRIBUTION_EVENT_TYPE = "booking";
/** What a booking with no UTM is attributed to. */
export const BOOKING_ATTRIBUTION_FALLBACK = {
  source: "cal.com",
  medium: "booking",
  campaign: "(none)",
} as const;

/** One answer's value: `{ value }` (webhook) or the plain value (list). */
function answerValue(answer: unknown): string | undefined {
  const raw =
    answer && typeof answer === "object" && !Array.isArray(answer)
      ? (answer as { value?: unknown }).value
      : answer;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The standard UTM names a UTM object may carry without the `utm_` prefix. */
const BARE_UTM_KEYS = new Set([
  "source",
  "medium",
  "campaign",
  "term",
  "content",
]);

/**
 * A UTM object on the payload (`tracking`, `utm` or `utmParams`), keyed as
 * `utm_source` or as a bare `source`, normalised to `utm_*` keys.
 */
function utmObject(payload: CalBookingPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const candidate of [payload.tracking, payload.utm, payload.utmParams]) {
    for (const [key, value] of Object.entries(asRecord(candidate))) {
      const name = key.trim().toLowerCase();
      const utmKey = BARE_UTM_KEYS.has(name) ? `utm_${name}` : name;
      if (!(utmKey in out)) out[utmKey] = value;
    }
  }
  return out;
}

/**
 * Every `utm_*` value the booking carries, and its `referrer`. The booker's
 * answers win (the webhook's `responses` first, then the user-field and v2
 * list shapes), then a UTM object on the payload, then booking metadata.
 */
export function bookingUtmParams(payload: CalBookingPayload): {
  utm: Record<string, string>;
  referrer?: string;
} {
  const sources = [
    payload.responses,
    payload.userFieldsResponses,
    payload.bookingFieldsResponses,
    utmObject(payload),
    payload.metadata,
  ].map(asRecord);
  const utm: Record<string, string> = {};
  let referrer: string | undefined;
  for (const source of sources) {
    for (const [key, answer] of Object.entries(source)) {
      const name = key.trim().toLowerCase();
      const value = answerValue(answer);
      if (!value) continue;
      if (name.startsWith("utm_") && !(name in utm)) utm[name] = value;
      if (name === "referrer" && !referrer) referrer = value;
    }
  }
  return { utm, ...(referrer ? { referrer } : {}) };
}

/**
 * The booking's `attribution-event` properties. `receivedAt` is the time the
 * booking was made when the payload does not carry its own `createdAt` (the
 * webhook envelope's `createdAt`, else the time the pod received it): the
 * kind requires a timestamp, so one is always set.
 */
export function bookingAttributionProperties(
  payload: CalBookingPayload,
  receivedAt: string
): Record<string, unknown> {
  const { utm, referrer } = bookingUtmParams(payload);
  const uid = payload.uid?.trim() || undefined;
  const eventTypeId = payload.eventTypeId ?? undefined;
  const bookingId = payload.bookingId ?? payload.id ?? undefined;
  return {
    source: utm.utm_source ?? BOOKING_ATTRIBUTION_FALLBACK.source,
    medium: utm.utm_medium ?? BOOKING_ATTRIBUTION_FALLBACK.medium,
    campaign: utm.utm_campaign ?? BOOKING_ATTRIBUTION_FALLBACK.campaign,
    timestamp: payload.createdAt?.trim() || receivedAt,
    eventtype: BOOKING_ATTRIBUTION_EVENT_TYPE,
    ...(referrer ? { referrer } : {}),
    ...(Object.keys(utm).length > 0 ? { utmparams: utm } : {}),
    metadata: {
      provider: "cal.com",
      ...(uid ? { calBookingUid: uid } : {}),
      ...(eventTypeId != null ? { eventTypeId } : {}),
      ...(bookingId != null ? { bookingId } : {}),
    },
  };
}

export interface MapBookingOptions {
  /**
   * Add the booking's `attribution-event` (linked to the person). Only when
   * the kind exists where the booking lands: `bookingGraphFor` decides, so a
   * pod without the kind still records the booking.
   */
  attribution?: { receivedAt: string };
}

/** Prefer the explicit video link, else a location that is itself a URL. */
export function meetLink(payload: CalBookingPayload): string | undefined {
  const v = payload.videoCallData?.url?.trim();
  if (v) return v;
  if (payload.meetingUrl?.trim()) return payload.meetingUrl.trim();
  const loc = payload.location?.trim();
  if (loc && /^https?:\/\//i.test(loc)) return loc;
  return undefined;
}

/**
 * Map ONE Cal.com booking to a CRM graph. Deterministic + pure. Always yields a
 * `person` wearing the `lead` role and an `event` (the call); a `company` only
 * for corporate email domains. Never a `deal`.
 */
export function mapBookingToGraph(
  payload: CalBookingPayload,
  options: MapBookingOptions = {}
): BookingGraph {
  const attendee = (payload.attendees ?? [])[0] ?? {};
  const email = attendee.email?.trim() || undefined;
  const name =
    attendee.name?.trim() ||
    (email ? email.split("@")[0] : "") ||
    "Unknown contact";

  const startDate = (payload.startTime ?? payload.start)?.trim() || undefined;
  const endDate = (payload.endTime ?? payload.end)?.trim() || undefined;
  const calendarLink = meetLink(payload);
  const uid = payload.uid?.trim() || undefined;
  const physicalLocation =
    payload.location && !/^https?:\/\//i.test(payload.location)
      ? payload.location.trim()
      : undefined;

  const entities: CaptureGraphEntity[] = [];
  const relations: CaptureGraphRelation[] = [];

  // person — email drives global identity dedup (resolveIdentity in the door);
  // the lead role rides on it (attach, or move forward only).
  entities.push({
    ref: "person",
    profileSlug: "person",
    title: name,
    properties: {
      ...(email ? { email } : {}),
      source: "cal.com",
    },
    facets: [
      {
        profileSlug: BOOKING_LEAD_ROLE,
        status: BOOKING_LEAD_STAGE,
        properties: { leadStage: BOOKING_LEAD_STAGE },
        advanceExisting: true,
      },
    ],
  });

  // company — only for a corporate email domain (website drives its dedup).
  const domain = emailDomain(email);
  const hasCompany = isCorporateDomain(domain);
  if (hasCompany && domain) {
    entities.push({
      ref: "company",
      profileSlug: "company",
      title: companyNameFromDomain(domain),
      properties: {
        website: `https://${domain}`,
        source: "cal.com",
      },
    });
  }

  // event — the call itself; shaped for event-sync (startDate/endDate/calendarLink).
  entities.push({
    ref: "event",
    profileSlug: "event",
    title: payload.title?.trim() || `Call with ${name}`,
    properties: {
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(calendarLink ? { calendarLink } : {}),
      ...(physicalLocation ? { location: physicalLocation } : {}),
      source: "cal.com",
      ...(uid ? { calBookingUid: uid } : {}),
    },
  });

  // relations — the call is attended by the person (the lead's agenda), and
  // the person works at the company (best-effort: materialization keeps
  // entities even if a relation type fails to resolve).
  relations.push({
    sourceRef: "event",
    targetRef: "person",
    type: RELATION_ATTENDED_BY,
  });
  if (hasCompany) {
    relations.push({
      sourceRef: "person",
      targetRef: "company",
      type: RELATION_WORKS_AT,
    });
  }

  // attribution-event — rides in the SAME graph as the booking, so it lands
  // (or is proposed) with it and is deduped by the same keys: the uid+trigger
  // seen-map and the proposal's idempotency key. Its title names the booking
  // uid: the duplicate door matches same-kind EXACT titles, and a title two
  // bookings could share would file the second booking for review.
  if (options.attribution) {
    entities.push({
      ref: "attribution",
      profileSlug: BOOKING_ATTRIBUTION_KIND,
      title: `Booking: ${name} (${uid ?? startDate ?? options.attribution.receivedAt})`,
      properties: bookingAttributionProperties(
        payload,
        options.attribution.receivedAt
      ),
    });
    relations.push({
      sourceRef: "attribution",
      targetRef: "person",
      type: RELATION_RELATES_TO,
    });
  }

  return { entities, relations };
}
